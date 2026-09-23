/** Declares a store that runs on SQLite where the platform provides it and on an in-memory row table elsewhere. */
import { VersionAtom } from './reactivity/version_atom';
import { RowShape, RowTable, RowTableSchema } from './table/types';
import { NativeShredSpec } from './write/shred_spec';
import { SqliteConnection } from './table/connection';
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
    /**
     * Moves the store onto SQLite over `conn`. Once, during startup, before anything reads it. With `recovery`, a SQLite
     * failure mid-session reopens the database rather than falling back onto an in-memory table.
     */
    bindSqlite: (conn: SqliteConnection, recovery?: SqliteRecovery) => void;
    /**
     * Moves a store that is already running — on the in-memory table it started or fell back on — onto SQLite over
     * `conn`, forgetting what the table it leaves had fetched and having every reader look again. Throws, leaving the
     * store where it was, if the store cannot be built over `conn`.
     */
    moveToSqlite: (conn: SqliteConnection, recovery?: SqliteRecovery) => void;
    /** Drops the store back onto an in-memory table and tells every reader to look again; idempotent, and deferred to a microtask. */
    degrade: (reason: {
        context: string;
        error?: unknown;
        extra?: Record<string, unknown>;
    }) => void;
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
/** How a store gets its database back when SQLite fails under it mid-session. */
export interface SqliteRecovery {
    /** A fresh connection to the same database; `discard` deletes the database first, for one that is corrupt. */
    reopen: (options: {
        discard: boolean;
    }) => SqliteConnection;
    /** Told when the store stopped trying and fell back onto an in-memory table, so a later retry can pick it up. */
    onFallback?: () => void;
}
/**
 * How a store declares itself: one descriptor, and both platforms are wired. What comes back already runs on an
 * in-memory row table, so web and tests need nothing further; mobile calls `bindSqlite` with an open connection during
 * startup. A SQLite failure mid-session reopens the database when the bind said how, and falls back onto an in-memory
 * table when it did not or reopening keeps failing.
 */
export declare function defineSqliteStore<Row extends RowShape, Surface extends StoreSurface, Caps extends StoreCapabilities = Record<string, never>>(config: SqliteStoreConfig<Row, Surface, Caps>): SqliteStore<Row, Surface, Caps>;
//# sourceMappingURL=define_sqlite_store.d.ts.map