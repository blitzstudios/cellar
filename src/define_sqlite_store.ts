/** Declares a store that runs on SQLite everywhere: the device's on mobile, and sql.js on web and in tests. */

import { reportStoreDegradation } from './diagnostics/telemetry';
import { createVersionAtom, VersionAtom } from './reactivity/version_atom';
import { RowShape, RowTable, RowTableSchema } from './table/types';
import { NativeShredSpec } from './write/shred_spec';
import { guardedConnection, SqliteConnection } from './table/connection';
import { createSqliteRowTable } from './table/sqlite';

/** What a store builds from its connection beside the row table: a ranker that runs its own SQL, say. */
export type StoreCapabilities = object;

/**
 * What a store publishes: its reads, each becoming a `use`/`get` pair on the facade; its `push` group, for rows a
 * caller outside the store hands in, such as socket frames; and its lifecycle hooks.
 */
export interface StoreSurface {
  reads: object;
  push?: object;
  lifecycle?: {
    forget?: () => void;
  };
}

/**
 * What a store declares itself with: its name, its row schema, and `build`, which makes its surface over a row table.
 * The two optional fields are a spec for shredding an ingest in C++, and `capabilities`, for what the store builds
 * from the connection itself, such as a ranker that runs the store's own SQL.
 */
export interface SqliteStoreConfig<Row extends RowShape, Surface extends StoreSurface, Caps extends StoreCapabilities = Record<string, never>> {
  name: string;
  schema: RowTableSchema<Row>;
  /**
   * The store over one row table. Called again each time the store moves to another connection — bound at startup,
   * reopened after a failure, or moved to its in-memory fallback — so it must hold nothing outside what it returns.
   */
  build: (table: RowTable<Row>, version: VersionAtom, caps: Caps) => Surface;
  nativeShredSpec?: NativeShredSpec;
  capabilities?: (conn: SqliteConnection) => Caps;
}

/** How a store gets a database back when SQLite fails under it. */
export interface SqliteRecovery {
  /** A fresh connection to the same database; `discard` deletes the database first, for one that is corrupt. */
  reopen: (options: { discard: boolean }) => SqliteConnection;
  /** A connection whose temp schema lives in memory, for when the database file itself keeps failing. */
  fallback?: () => SqliteConnection;
  /** Told when the store has left its database file — for the fallback, or for nothing — so a later retry can bring it back. */
  onLeftFile?: () => void;
}

export interface BindOptions {
  recovery?: SqliteRecovery;
  /** Builds the store's tables in the connection's temp schema, which `temp_store = MEMORY` keeps in memory. */
  temporary?: boolean;
  /** Set by a startup bind, which is expected before the first read, so a bind after one is reported. */
  startup?: boolean;
}

/**
 * A declared store. `reads`, `push` and `lifecycle` are looked up on the running surface at each access, so they follow
 * the store from one connection to the next; hold the store, not a member taken off it.
 */
export interface SqliteStore<Row extends RowShape, Surface extends StoreSurface> {
  readonly reads: Surface['reads'];
  readonly push: NonNullable<Surface['push']>;
  readonly lifecycle: NonNullable<Surface['lifecycle']>;
  /**
   * Runs the store on `conn`: whatever it ran on before forgets what it fetched, and every reader reads again. Throws,
   * leaving the store where it was, if the store cannot be built over `conn`.
   */
  bindSqlite: (conn: SqliteConnection, options?: BindOptions) => void;
  /** For tests, which put their own rows behind a store. Nothing outside a test calls these. */
  readonly testing: {
    /** The store's surface over `conn`, on the store's own version atom unless told otherwise, and the table it built, to seed. */
    over: (conn: SqliteConnection, options?: { version?: VersionAtom }) => { surface: Surface; table: RowTable<Row> };
    /** Runs the store on `surface` until the next swap or reset, so the facade reads what the test seeded. */
    swap: (surface: Surface) => void;
    /** Back to unbound, so one test's store is not the next one's. */
    reset: () => void;
  };
}

/** Answers every statement with no rows: what an unbound store runs on, so each read gives back its declared `empty`. */
const NULL_CONNECTION: SqliteConnection = { execute: () => ({ rows: { _array: [] } }) };

/**
 * Reopens a store gets per session before it moves to its fallback. A database that fails again straight after a
 * reopen is failing for a reason a reopen does not fix, and each attempt costs a refetch of every partition.
 */
const MAX_REOPENS = 2;

/** An error that means the file itself is unusable, so reopening it would only fail the same way. */
const CORRUPTION = /SQLITE_CORRUPT|SQLITE_NOTADB|malformed|not a database/i;
const messageOf = (error: unknown): string => String((error as { message?: unknown })?.message ?? error);

/**
 * A view of one group of the running surface, looked up at each access so that a move reaches every caller, including
 * one that took the group before it happened.
 */
function delegate<T extends object>(group: () => T | undefined, label: string): T {
  const resolve = (): T => {
    const target = group();
    if (!target) throw new Error(`${label}: this store has no such group`);
    return target;
  };
  return new Proxy({} as T, {
    get: (_target, key) => Reflect.get(resolve(), key),
    has: (_target, key) => Reflect.has(resolve(), key),
    ownKeys: () => Reflect.ownKeys(resolve()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), key);
      // The proxy's own target holds nothing, so every property it reports has to be configurable.
      return descriptor && { ...descriptor, configurable: true };
    },
  });
}

/**
 * How a store declares itself: one descriptor, run on SQLite wherever it is bound. Until a bind, the store runs over a
 * connection that answers nothing, so its reads give back their declared `empty`. On mobile, a SQLite failure
 * mid-session reopens the database, then moves the store to an in-memory database, and only then leaves it unbound.
 */
export function defineSqliteStore<Row extends RowShape, Surface extends StoreSurface, Caps extends StoreCapabilities = Record<string, never>>(
  config: SqliteStoreConfig<Row, Surface, Caps>,
): SqliteStore<Row, Surface> {
  const version = createVersionAtom(`${config.name}_version`);
  const extra = (more?: Record<string, unknown>) => ({ store: config.name, table: config.schema.table, ...more });
  const capabilitiesOf = (conn: SqliteConnection): Caps => (config.capabilities ? config.capabilities(conn) : ({} as Caps));

  let running: Surface | undefined;
  let hasBeenRead = false;
  let reopens = 0;
  // What each surface the store has run on primed, so leaving it can have the next one fetch for itself.
  let resets: Array<() => void> = [];

  const buildOver = (conn: SqliteConnection, temporary: boolean, atom: VersionAtom = version): { surface: Surface; table: RowTable<Row> } => {
    const table = createSqliteRowTable(config.schema, conn, config.nativeShredSpec, { temporary });
    return { surface: config.build(table, atom, capabilitiesOf(conn)), table };
  };

  const install = (surface: Surface): Surface => {
    const forget = surface.lifecycle?.forget;
    if (forget) resets.push(forget);
    running = surface;
    return surface;
  };

  /** Forgets what the running surface fetched, runs the store on `surface`, and has every reader read from it. */
  const replaceRunning = (surface: Surface): void => {
    const previous = resets;
    resets = [];
    previous.forEach((reset) => reset());
    install(surface);
    version.bumpAll();
  };

  // Built on first read, so a platform that binds first never builds it.
  const current = (): Surface => {
    hasBeenRead = true;
    return running ?? install(buildOver(NULL_CONNECTION, false).surface);
  };

  /** The store over SQLite on `conn`, guarded so that a failure on it reopens the database or moves the store off it. */
  const buildGuarded = (conn: SqliteConnection, options: BindOptions): Surface => {
    const guarded = guardedConnection(
      conn,
      (error, op) => onSqliteFailure(error, op, options),
      (error, op) =>
        reportStoreDegradation({
          scope: `${config.name}.contention`,
          context:
            `SQLite \`${op}\` was refused because another statement held the connection — absorbed, but the store is one ` +
            'connection short of where it should be, which usually means its dedicated reader never opened',
          error,
          extra: extra({ op }),
        }),
    );
    return buildOver(guarded, !!options.temporary).surface;
  };

  /** The last resort: nothing to read from, reported, and handed to the binding so a later retry can bring the store back. */
  const leaveUnbound = (context: string, error: unknown, options: BindOptions, more?: Record<string, unknown>): void => {
    reportStoreDegradation({ scope: `${config.name}.unbound`, context, error, extra: extra(more) });
    replaceRunning(buildOver(NULL_CONNECTION, false).surface);
    options.recovery?.onLeftFile?.();
  };

  /** Moves the store to its in-memory fallback, or leaves it unbound when there is none. */
  const moveToFallback = (error: unknown, op: string, options: BindOptions): void => {
    const fallback = options.recovery?.fallback;
    if (!fallback) {
      leaveUnbound(`SQLite \`${op}\` failed mid-session and the store has no fallback; its reads are empty until a retry binds it`, error, options, { op });
      return;
    }
    try {
      const fallbackOptions: BindOptions = { temporary: true, recovery: { reopen: options.recovery!.reopen, onLeftFile: options.recovery!.onLeftFile } };
      replaceRunning(buildGuarded(fallback(), fallbackOptions));
      options.recovery?.onLeftFile?.();
      reportStoreDegradation({
        scope: `${config.name}.in_memory`,
        context: `SQLite \`${op}\` kept failing on the database file; the store runs on an in-memory database and refetches into it`,
        error,
        extra: extra({ op }),
      });
    } catch (fallbackError) {
      leaveUnbound('the in-memory fallback could not be opened either; the store reads empty until a retry binds it', fallbackError, options, {
        op,
        firstError: messageOf(error),
      });
    }
  };

  /**
   * A statement failed, and the connection it ran on answers nothing from here. The store reopens the database — or,
   * when the file is what failed, deletes it and starts empty — and refetches into it; after that, it moves to its
   * in-memory fallback. Deferred, so the failing statement's caller unwinds first.
   */
  const onSqliteFailure = (error: unknown, op: string, options: BindOptions): void => {
    queueMicrotask(() => {
      const recovery = options.recovery;
      if (!recovery || options.temporary || reopens >= MAX_REOPENS) {
        moveToFallback(error, op, options);
        return;
      }
      reopens += 1;
      const discard = CORRUPTION.test(messageOf(error));
      try {
        const conn = recovery.reopen({ discard });
        // A write that failed may have left rows short of what their ETag vouches for, so each partition's next fetch
        // brings a whole body rather than a 304.
        if (!discard && config.schema.meta) {
          try {
            conn.execute(`DELETE FROM ${config.schema.meta.table};`);
          } catch {
            /* a database with no meta table yet has no ETags to clear */
          }
        }
        replaceRunning(buildGuarded(conn, options));
        reportStoreDegradation({
          scope: `${config.name}.reopened`,
          context: `SQLite \`${op}\` failed mid-session; the store reopened its database${discard ? ', deleting it first,' : ''} and will refetch into it`,
          error,
          extra: extra({ op, discard, reopens }),
          severity: 'info',
        });
      } catch (reopenError) {
        moveToFallback(reopenError, op, options);
      }
    });
  };

  const bindSqlite = (conn: SqliteConnection, options: BindOptions = {}): void => {
    const surface = buildGuarded(conn, options);
    // Reported rather than warned: a startup bind that lands after a read means startup ordering moved, and that
    // read's first paint was empty.
    if (options.startup && hasBeenRead) {
      reportStoreDegradation({
        scope: 'store.late_bind',
        context:
          'a store was bound at startup after something had already read from it, so that read painted empty first. Move the ' +
          '`bindOffHeapStore` call earlier in startup.',
      });
    }
    if (!options.temporary) reopens = 0;
    replaceRunning(surface);
  };

  return {
    reads: delegate(() => current().reads, `${config.name}.reads`),
    push: delegate(() => current().push, `${config.name}.push`) as NonNullable<Surface['push']>,
    lifecycle: delegate(() => current().lifecycle, `${config.name}.lifecycle`) as NonNullable<Surface['lifecycle']>,
    bindSqlite,
    testing: {
      over: (conn, options = {}) => buildOver(conn, false, options.version),
      swap: (surface) => {
        running = surface;
      },
      reset: () => {
        running = undefined;
        hasBeenRead = false;
        reopens = 0;
        resets = [];
      },
    },
  };
}
