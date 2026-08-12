/** Declares a store that runs on SQLite where the platform provides it and on an in-memory row table elsewhere. */

import { createOnceGuard } from './diagnostics/once_guard';
import { reportStoreDegradation } from './diagnostics/telemetry';
import { createVersionAtom, VersionAtom } from './reactivity/version_atom';
import { createMemoryRowTable } from './table/memory';
import { RowShape, RowTable, RowTableSchema } from './table/types';
import { NativeShredSpec } from './write/shred_spec';
import { guardedConnection, SqliteConnection } from './table/connection';
import { createSqliteRowTable } from './table/sqlite';

/** SQLite-only accelerators: the optimizations a backend picks up where SQLite offers them. */
export type StoreCapabilities = object;

/**
 * What a store backend publishes: its reads, each becoming a `use`/`get` pair on the facade; its `push` group, for
 * rows a caller outside the store hands in, such as socket frames; and its lifecycle hooks.
 */
export interface StoreBackendShape {
  reads: object;
  push?: object;
  lifecycle?: {
    forget?: () => void;
  };
}

/**
 * What a store declares itself with: its name, its row schema, and the one function that builds a backend over
 * whichever row table the platform gives it. The two optional fields are the SQLite-only extras — a spec for shredding
 * an ingest in C++, and `sqliteCapabilities` for an accelerator that needs the live connection.
 */
export interface SqliteStoreConfig<Row extends RowShape, Backend extends StoreBackendShape, Caps extends StoreCapabilities = Record<string, never>> {
  name: string;
  schema: RowTableSchema<Row>;
  /** `caps` is empty for the in-memory backend, so every branch on one needs a JS fallback beside it. */
  buildBackend: (table: RowTable<Row>, version: VersionAtom, caps: Partial<Caps>) => Backend;
  nativeShredSpec?: NativeShredSpec;
  sqliteCapabilities?: (conn: SqliteConnection) => Caps;
}

/**
 * What a store's `store.ts` holds and re-exports: the version atom every read subscribes to, the accessors startup
 * binds the platform's backend through, the exit to the in-memory backend when SQLite fails, and the builder mobile's
 * `bindSqliteStore` hands an open connection to during startup.
 */
export interface SqliteStore<Row extends RowShape, Backend extends StoreBackendShape> {
  version: VersionAtom;
  getBackend: () => Backend;
  setBackend: (backend: Backend) => void;
  /** Swaps back to the in-memory backend and bumps every version; idempotent, and deferred to a microtask. */
  degrade: (reason: { context: string; error?: unknown; extra?: Record<string, unknown> }) => void;
  onDegrade: (reset: () => void) => void;
  createSqliteBackend: (conn: SqliteConnection) => Backend;
}

const NO_CAPS = {} as const;

const lateBindGuard = createOnceGuard();

/**
 * How a store declares itself: one descriptor, and both platforms are wired. What comes back already runs on an
 * in-memory row table, so web and tests need nothing further; mobile calls `createSqliteBackend` with an open
 * connection during startup, and a SQLite failure mid-session drops the store back onto that in-memory table.
 */
export function defineSqliteStore<Row extends RowShape, Backend extends StoreBackendShape, Caps extends StoreCapabilities = Record<string, never>>(
  config: SqliteStoreConfig<Row, Backend, Caps>,
): SqliteStore<Row, Backend> {
  const version = createVersionAtom(`${config.name}_version`);
  const buildMemoryBackend = (): Backend => config.buildBackend(createMemoryRowTable(config.schema), version, NO_CAPS);

  // The one slot every read resolves its backend through, holding the in-memory one until a platform binds its own.
  // Built on first read, so a platform that binds never builds it, and swapped before that read, so the accessor
  // hooks delegating to it stay rules-of-hooks safe.
  let active: Backend | undefined;
  let hasBeenRead = false;

  const getBackend = (): Backend => {
    hasBeenRead = true;
    return (active ??= buildMemoryBackend());
  };

  const setBackend = (backend: Backend): void => {
    if (__DEV__ && hasBeenRead && !lateBindGuard.seen('late_bind')) {
      // eslint-disable-next-line no-console
      console.warn(
        'store_backend_slot.late_bind: a store backend was registered after something had already read from it. Backends bind once, during ' +
          'startup, before the first read — reads taken against the previous backend are still holding its rows and versions, and nothing ' +
          're-renders when it is replaced. Move the `bindOffHeapStore` call earlier in startup.',
      );
    }
    active = backend;
  };

  let degraded = false;
  const resets: Array<() => void> = [];

  const degrade = (reason: { context: string; error?: unknown; extra?: Record<string, unknown> }): void => {
    if (degraded) return;
    degraded = true;
    reportStoreDegradation({ scope: `${config.name}.runtime`, context: reason.context, error: reason.error, extra: reason.extra });
    queueMicrotask(() => {
      resets.forEach((reset) => reset());
      // Assigned rather than set: the late-bind warning is about binding order during startup, and this swap is
      // neither late nor a bind.
      active = buildMemoryBackend();
      version.bumpAll();
    });
  };

  return {
    version,
    getBackend,
    setBackend,
    degrade,
    onDegrade: (reset: () => void) => {
      resets.push(reset);
    },
    createSqliteBackend: (conn) => {
      // Guarded before anything is built on it, so a failure below degrades the store.
      const guarded = guardedConnection(conn, (error, op) =>
        degrade({
          context: `SQLite \`${op}\` failed mid-session; the store is now on its in-memory backend and will refetch`,
          error,
          extra: { store: config.name, table: config.schema.table, op },
        }),
      );
      const backend = config.buildBackend(
        createSqliteRowTable(config.schema, guarded, config.nativeShredSpec),
        version,
        config.sqliteCapabilities?.(guarded) ?? NO_CAPS,
      );
      const forget = backend.lifecycle?.forget;
      if (forget) resets.push(forget);
      return backend;
    },
  };
}
