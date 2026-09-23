/** Declares a store that runs on SQLite where the platform provides it and on an in-memory row table elsewhere. */

import { reportStoreDegradation } from './diagnostics/telemetry';
import { createVersionAtom, VersionAtom } from './reactivity/version_atom';
import { createMemoryRowTable } from './table/memory';
import { RowShape, RowTable, RowTableSchema } from './table/types';
import { NativeShredSpec } from './write/shred_spec';
import { guardedConnection, SqliteConnection } from './table/connection';
import { createSqliteRowTable } from './table/sqlite';

/** SQLite-only accelerators: the optimizations a store picks up where SQLite offers them. */
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
 * The two optional fields are the SQLite-only extras — a spec for shredding an ingest in C++, and `sqliteCapabilities`
 * for an accelerator that needs the live connection.
 */
export interface SqliteStoreConfig<Row extends RowShape, Surface extends StoreSurface, Caps extends StoreCapabilities = Record<string, never>> {
  name: string;
  schema: RowTableSchema<Row>;
  /**
   * The store over one row table. Called once for the in-memory table a store starts on, again when SQLite is bound,
   * and again if SQLite fails and the store falls back — so it must hold nothing outside what it returns. `caps` is
   * empty on the in-memory table, so every branch on one needs a JS fallback beside it.
   */
  build: (table: RowTable<Row>, version: VersionAtom, caps: Partial<Caps>) => Surface;
  nativeShredSpec?: NativeShredSpec;
  sqliteCapabilities?: (conn: SqliteConnection) => Caps;
}

/** What a test takes a store over: a table of its own, and the version atom and capabilities it wants that to run with. */
export interface StoreOverOptions<Caps> {
  version?: VersionAtom;
  caps?: Partial<Caps>;
}

/**
 * A declared store. `reads`, `push` and `lifecycle` are looked up on the running table at each access, so they follow
 * the store onto SQLite at startup and back off it if SQLite fails; hold the store, not a member taken off it.
 */
export interface SqliteStore<Row extends RowShape, Surface extends StoreSurface, Caps extends StoreCapabilities = Record<string, never>> {
  readonly reads: Surface['reads'];
  readonly push: NonNullable<Surface['push']>;
  readonly lifecycle: NonNullable<Surface['lifecycle']>;
  /** Moves the store onto SQLite over `conn`. Once, during startup, before anything reads it. */
  bindSqlite: (conn: SqliteConnection) => void;
  /** Drops the store back onto an in-memory table and tells every reader to look again; idempotent, and deferred to a microtask. */
  degrade: (reason: { context: string; error?: unknown; extra?: Record<string, unknown> }) => void;
  /** For tests, which put their own rows behind a store. Nothing outside a test calls these. */
  readonly testing: {
    /** The store's surface over `table` (a fresh in-memory one if omitted), on the store's own version atom unless told otherwise. */
    over: (table?: RowTable<Row>, options?: StoreOverOptions<Caps>) => Surface;
    /** Runs the store on `surface` until the next swap or reset, so the facade reads what the test seeded. */
    swap: (surface: Surface) => void;
    /** Back to a fresh in-memory table, and forgets a degrade, so one test's store is not the next one's. */
    reset: () => void;
  };
}

const NO_CAPS = {} as const;

/**
 * A view of one group of the running surface, looked up at each access so that a bind or a degrade reaches every
 * caller, including one that took the group before it happened.
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
 * How a store declares itself: one descriptor, and both platforms are wired. What comes back already runs on an
 * in-memory row table, so web and tests need nothing further; mobile calls `bindSqlite` with an open connection during
 * startup, and a SQLite failure mid-session drops the store back onto an in-memory table.
 */
export function defineSqliteStore<Row extends RowShape, Surface extends StoreSurface, Caps extends StoreCapabilities = Record<string, never>>(
  config: SqliteStoreConfig<Row, Surface, Caps>,
): SqliteStore<Row, Surface, Caps> {
  const version = createVersionAtom(`${config.name}_version`);
  const buildInMemory = (): Surface => config.build(createMemoryRowTable(config.schema), version, NO_CAPS);

  // Built on first read, so a platform that binds never builds it, and swapped before that read, so a hook that
  // resolves through it every render keeps resolving to the same thing.
  let running: Surface | undefined;
  let hasBeenRead = false;
  const current = (): Surface => {
    hasBeenRead = true;
    return (running ??= buildInMemory());
  };

  let degraded = false;
  let resets: Array<() => void> = [];

  const degrade = (reason: { context: string; error?: unknown; extra?: Record<string, unknown> }): void => {
    if (degraded) return;
    degraded = true;
    reportStoreDegradation({ scope: `${config.name}.runtime`, context: reason.context, error: reason.error, extra: reason.extra });
    queueMicrotask(() => {
      resets.forEach((reset) => reset());
      running = buildInMemory();
      version.bumpAll();
    });
  };

  const bindSqlite = (conn: SqliteConnection): void => {
    // Guarded before anything is built on it, so a failure below degrades the store.
    const guarded = guardedConnection(
      conn,
      (error, op) =>
        degrade({
          context: `SQLite \`${op}\` failed mid-session; the store is now on an in-memory table and will refetch`,
          error,
          extra: { store: config.name, table: config.schema.table, op },
        }),
      (error, op) =>
        reportStoreDegradation({
          scope: `${config.name}.contention`,
          context:
            `SQLite \`${op}\` was refused because another statement held the connection — absorbed rather than degraded, but the ` +
            'store is one connection short of where it should be, which usually means its dedicated reader never opened',
          error,
          extra: { store: config.name, table: config.schema.table, op },
        }),
    );
    const onSqlite = config.build(createSqliteRowTable(config.schema, guarded, config.nativeShredSpec), version, config.sqliteCapabilities?.(guarded) ?? NO_CAPS);
    const forget = onSqlite.lifecycle?.forget;
    if (forget) resets.push(forget);

    // Reported rather than warned: in a release build this is silent, and the symptom — a screen that is simply always
    // empty for some users — is one nobody would trace back to startup ordering.
    if (hasBeenRead) {
      reportStoreDegradation({
        scope: 'store.late_bind',
        context:
          'a store was bound to SQLite after something had already read from it. A store binds once, during startup, before the ' +
          'first read — reads taken before the bind are still holding the in-memory rows and versions, and nothing re-renders when ' +
          'it moves. Move the `bindOffHeapStore` call earlier in startup.',
      });
    }
    running = onSqlite;
  };

  return {
    reads: delegate(() => current().reads, `${config.name}.reads`),
    push: delegate(() => current().push, `${config.name}.push`) as NonNullable<Surface['push']>,
    lifecycle: delegate(() => current().lifecycle, `${config.name}.lifecycle`) as NonNullable<Surface['lifecycle']>,
    bindSqlite,
    degrade,
    testing: {
      over: (table = createMemoryRowTable(config.schema), options = {}) => config.build(table, options.version ?? version, options.caps ?? NO_CAPS),
      swap: (surface) => {
        running = surface;
      },
      reset: () => {
        running = undefined;
        hasBeenRead = false;
        degraded = false;
        resets = [];
      },
    },
  };
}
