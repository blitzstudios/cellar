/** Declares a store that runs on SQLite everywhere: the device's on mobile, and sql.js on web and in tests. */
import { VersionAtom } from './reactivity/version_atom';
import { RowShape, RowTable, RowTableSchema } from './table/types';
import { NativeShredSpec } from './write/shred_spec';
import { SqliteConnection } from './table/connection';
/** Things a store builds from its database connection besides the row table, such as a ranker that runs its own SQL. */
export type StoreCapabilities = object;
/** What a store's `build` returns: its reads, its push functions, and its lifecycle functions. */
export interface StoreSurface {
    /** The store's reads, by name. A facade publishes each as a `use*` hook and a `get*` getter. */
    reads: object;
    /** Functions that write rows handed in from outside a fetch, such as socket frames. */
    push?: object;
    /** Functions that act on the store as a whole. */
    lifecycle?: {
        /** Forgets what the store has fetched, so every partition reads as never fetched. */
        forget?: () => void;
    };
}
/** Everything {@link defineSqliteStore} needs to declare a store: its name, its table, and how to build it. */
export interface SqliteStoreConfig<Row extends RowShape, Surface extends StoreSurface, Caps extends StoreCapabilities = Record<string, never>> {
    /** The store's name, used in logs, error reports and its version store. */
    name: string;
    /** The store's row table. */
    schema: RowTableSchema<Row>;
    /**
     * Builds the store's reads, push and lifecycle functions over its row table. Called again each time the store moves
     * to another connection — bound at startup, reopened after a failure, or moved to its in-memory fallback — so it
     * must keep nothing outside what it returns.
     */
    build: (table: RowTable<Row>, version: VersionAtom, caps: Caps) => Surface;
    /** How the native shred builds this table's rows from a response body; omit it to always build rows in JS. */
    nativeShredSpec?: NativeShredSpec;
    /** Builds the store's {@link StoreCapabilities} from its connection; `build` receives them as `caps`. */
    capabilities?: (conn: SqliteConnection) => Caps;
}
/** How a store gets a database back when SQLite fails under it. */
export interface SqliteRecovery {
    /** Opens a fresh connection to the same database. */
    reopen: (options: {
        /** Deletes the database file first, for one that is corrupt. */
        discard: boolean;
    }) => SqliteConnection;
    /** Opens an in-memory database to run the store on when its database file keeps failing. */
    fallback?: () => SqliteConnection;
    /**
     * Called when the store stops using its database file — for the in-memory database, or for nothing — so a later retry
     * can move it back.
     */
    onLeftFile?: () => void;
}
/** Options for {@link SqliteStore.bindSqlite}. */
export interface BindOptions {
    /** How to get a working database back if SQLite fails mid-session; without it, a failure leaves the store unbound. */
    recovery?: SqliteRecovery;
    /** Builds the store's tables in the connection's temp schema, which `temp_store = MEMORY` keeps in memory. */
    temporary?: boolean;
    /**
     * Marks the app's startup bind, which should come before the store's first read; one that comes after is reported.
     */
    startup?: boolean;
}
/**
 * A store declared with {@link defineSqliteStore}. `reads`, `push` and `lifecycle` are looked up on the database the
 * store is currently running on at each access, so they follow the store when it moves; keep the store, not a member
 * taken off it.
 */
export interface SqliteStore<Row extends RowShape, Surface extends StoreSurface> {
    /** The store's reads, by name. */
    readonly reads: Surface['reads'];
    /** The store's functions for writing rows handed in from outside a fetch. */
    readonly push: NonNullable<Surface['push']>;
    /** The store's functions that act on it as a whole. */
    readonly lifecycle: NonNullable<Surface['lifecycle']>;
    /**
     * Runs the store on `conn`. What it ran on before forgets what it fetched, and every reader reads again. Throws, and
     * leaves the store as it was, if the store cannot be built over `conn`.
     */
    bindSqlite: (conn: SqliteConnection, options?: BindOptions) => void;
    /** Functions for tests to run the store over rows they seed. Nothing outside a test calls these. */
    readonly testing: {
        /**
         * Builds the store over `conn` without switching to it, returning its surface and the table to seed. Uses the
         * store's own version store unless `options.version` gives another.
         */
        over: (conn: SqliteConnection, options?: {
            /** The version store to build over, in place of the store's own. */
            version?: VersionAtom;
        }) => {
            /** The store's reads, push and lifecycle functions over `conn`. */
            surface: Surface;
            /** The row table built over `conn`, to seed rows into. */
            table: RowTable<Row>;
        };
        /** Runs the store on `surface` until the next swap or reset, so the facade reads what the test seeded. */
        swap: (surface: Surface) => void;
        /** Returns the store to unbound, so one test's rows don't leak into the next. */
        reset: () => void;
    };
}
/**
 * Declares a store: a row table plus the reads built over it, run on whatever SQLite database it is bound to. Until a
 * bind, every read returns its declared `empty`. On mobile, a SQLite failure mid-session reopens the database, then
 * moves the store to an in-memory database, and only then leaves it unbound.
 */
export declare function defineSqliteStore<Row extends RowShape, Surface extends StoreSurface, Caps extends StoreCapabilities = Record<string, never>>(config: SqliteStoreConfig<Row, Surface, Caps>): SqliteStore<Row, Surface>;
//# sourceMappingURL=define_sqlite_store.d.ts.map