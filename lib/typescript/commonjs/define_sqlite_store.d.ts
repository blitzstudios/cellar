/**
 * Declares a store: a SQLite table of rows plus the reads, pushes and lifecycle functions built over it. A store runs
 * on SQLite everywhere (the device's SQLite on mobile, and sql.js, SQLite compiled to WebAssembly, on web and in
 * tests), and can move between databases during a session without its callers noticing.
 */
import { VersionAtom } from './reactivity/version_atom';
import { RowShape, RowTable, RowTableSchema } from './table/types';
import { NativeShredSpec } from './write/shred_spec';
import { SqliteConnection } from './table/connection';
import type { PartitionFetchSpec, Partitions, definePartitions } from './define_partitions';
import type { CommonDef, Read } from './read/surface';
import type { pairRead } from './read/facade';
import type { bindSqliteStore } from './nitro/nitro_connection';
/**
 * Objects a store builds from its database connection besides its row table, such as a ranker that runs its own SQL
 * queries. They are rebuilt with the rest of the store whenever it moves to another connection, and passed to
 * {@linkcode SqliteStoreConfig.build | build} as `caps`.
 */
export type StoreCapabilities = object;
/**
 * What a store's {@linkcode SqliteStoreConfig.build | build} returns: the store's public functions, in three groups.
 * Callers reach them through the store (`store.reads.x`), which always points at the surface built over the database
 * the store currently runs on.
 */
export interface StoreSurface {
    /**
     * The store's reads, by name: each a declared read (from {@linkcode Partitions.read | read},
     * {@linkcode Partitions.readMany | readMany} or {@linkcode Partitions.readGrouped | readGrouped}) with a
     * {@linkcode Read.useValue | useValue} hook and a {@linkcode Read.getValue | getValue} getter. A service publishes
     * each one as a `use*` hook and a `get*` getter with {@linkcode pairRead}.
     */
    reads: object;
    /** Functions that write rows that arrive outside a fetch, such as socket pushes, and tell their readers. */
    push?: object;
    /** Functions that act on the store's partitions as a whole, such as fetching, refetching or discarding them. */
    lifecycle?: {
        /**
         * Discards the fetch state of every partition, so each is fetched again by its next reader. Called on the old
         * surface whenever the store moves to another database, since the old fetches wrote rows into the old one.
         */
        forget?: () => void;
    };
}
/**
 * Everything {@linkcode defineSqliteStore} needs to declare a store: its name, its table, and how to build its
 * functions.
 */
export interface SqliteStoreConfig<Row extends RowShape, Surface extends StoreSurface, Caps extends StoreCapabilities = Record<string, never>> {
    /** The store's name, such as `player`. It names the store's version atom and appears in logs and error reports. */
    name: string;
    /**
     * The declaration of the store's SQLite table: its columns, primary key, unit column, indexes and ETag table. The
     * table is created, or brought up to date, whenever the store is bound to a database.
     */
    schema: RowTableSchema<Row>;
    /**
     * Builds the store's public functions (reads, push and lifecycle) over its row table, usually by calling
     * {@linkcode definePartitions} and declaring reads on the result. `version` is the store's version atom, which is the
     * same one for the life of the store; `caps` are what {@linkcode SqliteStoreConfig.capabilities | capabilities}
     * built.
     *
     * It runs again every time the store moves to another database: at startup, after a failure reopens the database, and
     * when the store moves to an in-memory database. So it must keep all its state in what it returns, never in variables
     * outside it, or that state would outlive the database it describes.
     */
    build: (table: RowTable<Row>, version: VersionAtom, caps: Caps) => Surface;
    /**
     * The store's native shred programs, which let the C++ shredder write a fetched response's rows without building JS
     * objects for them. Omit it to always build rows in JS with the partition's
     * {@linkcode PartitionFetchSpec.parse | parse}.
     */
    nativeShredSpec?: NativeShredSpec;
    /**
     * Builds the store's {@linkcode StoreCapabilities} (objects that need the database connection, such as a ranker that
     * runs its own SQL) each time the store is built over a connection; {@linkcode SqliteStoreConfig.build | build}
     * receives them as `caps`.
     */
    capabilities?: (conn: SqliteConnection) => Caps;
}
/**
 * How a store gets a working database back when a SQLite statement fails during the session. The store first reopens
 * the database (up to twice per session), then moves to an in-memory database, and only if that fails too runs on
 * nothing, returning each read's {@linkcode CommonDef.empty | empty}. Every move rebuilds the store and fetches its
 * partitions again.
 */
export interface SqliteRecovery {
    /** Opens a new connection to the same database file, replacing the one that failed. */
    reopen: (options: {
        /**
         * Whether to delete the database file first. True when the error says the file is corrupt, so the reopened
         * database starts empty.
         */
        discard: boolean;
    }) => SqliteConnection;
    /** Opens an in-memory database for the store to run on when reopening its file hasn't fixed the failures. */
    fallback?: () => SqliteConnection;
    /**
     * Called when the store stops using its database file, for the in-memory database or for nothing, so the app can
     * later try to move it back onto the file.
     */
    onLeftFile?: () => void;
}
/** Options for {@linkcode SqliteStore.bindSqlite}. */
export interface BindOptions {
    /**
     * How to get a working database back if a SQLite statement fails later in the session: reopen the file, then move to
     * an in-memory database. Without it, a failure leaves the store running on nothing, with every read returning its
     * {@linkcode CommonDef.empty | empty}.
     */
    recovery?: SqliteRecovery;
    /**
     * Creates the store's tables as `TEMP` tables, which live in memory and start empty, instead of in the database file.
     * Used for the in-memory database a store falls back to.
     */
    temporary?: boolean;
    /**
     * Marks this as the app's startup bind. Startup binds should happen before anything reads the store, since a read
     * before the bind returns {@linkcode CommonDef.empty | empty} and paints an empty screen first; a startup bind that
     * comes after a read is reported.
     */
    startup?: boolean;
}
/**
 * A store declared with {@linkcode defineSqliteStore}. Until it is bound to a database, it runs on nothing, and every
 * read returns its {@linkcode CommonDef.empty | empty}.
 *
 * The store can move to a different database during a session (bound at startup, reopened after a failure, moved to an
 * in-memory database), and each move rebuilds its functions over the new one. {@linkcode SqliteStore.reads | reads},
 * {@linkcode SqliteStore.push | push} and {@linkcode SqliteStore.lifecycle | lifecycle} always point at the current
 * ones, looked up on each access, so code that keeps the store (or {@linkcode SqliteStore.reads | store.reads}) keeps
 * working across moves.
 */
export interface SqliteStore<Row extends RowShape, Surface extends StoreSurface> {
    /**
     * The store's reads, by name, from the database the store currently runs on: each a declared read with
     * {@linkcode Read.useValue | useValue} and {@linkcode Read.getValue | getValue}.
     */
    readonly reads: Surface['reads'];
    /**
     * The store's functions that write rows arriving outside a fetch, such as socket pushes, from the current database.
     */
    readonly push: NonNullable<Surface['push']>;
    /**
     * The store's functions that act on its partitions as a whole (fetching, refetching, discarding), from the current
     * database.
     */
    readonly lifecycle: NonNullable<Surface['lifecycle']>;
    /**
     * Moves the store onto the database behind `conn`: creates or updates its table there, builds its functions over it,
     * discards the fetch state of the database it ran on before, and re-renders every reader so each reads from the new
     * one (fetching its partitions again). If building over `conn` throws, the store keeps running where it was and the
     * error is rethrown.
     */
    bindSqlite: (conn: SqliteConnection, options?: BindOptions) => void;
    /** Functions for tests to run the store over rows they write themselves. Nothing outside a test calls these. */
    readonly testing: {
        /**
         * Builds the store's functions over `conn` without switching the store to them, and returns them with the row table
         * to write test rows into. The functions use the store's own version atom unless `options.version` gives another.
         */
        over: (conn: SqliteConnection, options?: {
            /**
             * A version atom for the built functions to use instead of the store's own, such as a test one that records
             * bumps.
             */
            version?: VersionAtom;
        }) => {
            /** The store's reads, push and lifecycle functions, built over `conn`. */
            surface: Surface;
            /** The row table built over `conn`, to write test rows into. */
            table: RowTable<Row>;
        };
        /**
         * Makes the store's {@linkcode SqliteStore.reads | reads}, {@linkcode SqliteStore.push | push} and
         * {@linkcode SqliteStore.lifecycle | lifecycle} point at `surface` (from `over`) until the next `swap` or `reset`,
         * so code under test that reads through the store sees the test's rows.
         */
        swap: (surface: Surface) => void;
        /**
         * Returns the store to its initial state, bound to nothing, so one test's rows and fetches don't leak into the
         * next.
         */
        reset: () => void;
    };
}
/**
 * Declares a store: a SQLite table of rows ({@linkcode SqliteStoreConfig.schema | schema}) plus the reads, pushes and
 * lifecycle functions {@linkcode SqliteStoreConfig.build | build} creates over it. The store starts bound to nothing,
 * where every read returns its {@linkcode CommonDef.empty | empty}, until the app binds it to a database with
 * {@linkcode SqliteStore.bindSqlite | bindSqlite} (on a device, through {@linkcode bindSqliteStore}).
 *
 * If a SQLite statement fails later in the session, the store recovers by itself when the bind supplied a
 * {@linkcode BindOptions.recovery | recovery}: it reopens the database (deleting the file first if it's corrupt), then
 * moves to an in-memory database, and only then runs on nothing. Each move rebuilds the store and re-renders its
 * readers, which fetch again.
 */
export declare function defineSqliteStore<Row extends RowShape, Surface extends StoreSurface, Caps extends StoreCapabilities = Record<string, never>>(config: SqliteStoreConfig<Row, Surface, Caps>): SqliteStore<Row, Surface>;
export type { CommonDef, PartitionFetchSpec, Partitions, Read, bindSqliteStore, definePartitions, pairRead };
//# sourceMappingURL=define_sqlite_store.d.ts.map