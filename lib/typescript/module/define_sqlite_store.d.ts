/** Declares a store that runs on SQLite where the platform provides it and on an in-memory row table elsewhere. */
import { VersionAtom } from './reactivity/version_atom';
import { RowShape, RowTable, RowTableSchema } from './table/types';
import { NativeShredSpec } from './write/shred_spec';
import { SqliteConnection } from './table/connection';
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
    degrade: (reason: {
        context: string;
        error?: unknown;
        extra?: Record<string, unknown>;
    }) => void;
    onDegrade: (reset: () => void) => void;
    createSqliteBackend: (conn: SqliteConnection) => Backend;
}
/**
 * How a store declares itself: one descriptor, and both platforms are wired. What comes back already runs on an
 * in-memory row table, so web and tests need nothing further; mobile calls `createSqliteBackend` with an open
 * connection during startup, and a SQLite failure mid-session drops the store back onto that in-memory table.
 */
export declare function defineSqliteStore<Row extends RowShape, Backend extends StoreBackendShape, Caps extends StoreCapabilities = Record<string, never>>(config: SqliteStoreConfig<Row, Backend, Caps>): SqliteStore<Row, Backend>;
//# sourceMappingURL=define_sqlite_store.d.ts.map