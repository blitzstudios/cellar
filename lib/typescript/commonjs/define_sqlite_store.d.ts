/** Declares a store that runs on SQLite everywhere: the device's on mobile, and sql.js on web and in tests. */
import { VersionAtom } from './reactivity/version_atom';
import { RowShape, RowTable, RowTableSchema } from './table/types';
import { NativeShredSpec } from './write/shred_spec';
import { SqliteConnection } from './table/connection';
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
    reopen: (options: {
        discard: boolean;
    }) => SqliteConnection;
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
        over: (conn: SqliteConnection, options?: {
            version?: VersionAtom;
        }) => {
            surface: Surface;
            table: RowTable<Row>;
        };
        /** Runs the store on `surface` until the next swap or reset, so the facade reads what the test seeded. */
        swap: (surface: Surface) => void;
        /** Back to unbound, so one test's store is not the next one's. */
        reset: () => void;
    };
}
/**
 * How a store declares itself: one descriptor, run on SQLite wherever it is bound. Until a bind, the store runs over a
 * connection that answers nothing, so its reads give back their declared `empty`. On mobile, a SQLite failure
 * mid-session reopens the database, then moves the store to an in-memory database, and only then leaves it unbound.
 */
export declare function defineSqliteStore<Row extends RowShape, Surface extends StoreSurface, Caps extends StoreCapabilities = Record<string, never>>(config: SqliteStoreConfig<Row, Surface, Caps>): SqliteStore<Row, Surface>;
//# sourceMappingURL=define_sqlite_store.d.ts.map