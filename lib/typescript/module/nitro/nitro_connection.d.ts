/**
 * The kernel's {@link SqliteConnection} over `react-native-nitro-sqlite`: it opens the database on device, applies the
 * pragmas a store depends on, narrows JS values to what the JSI bridge binds, and routes a native shred through the
 * sentinel the fork's C++ matches. A bind that fails is reported rather than thrown, and the store moves to an
 * in-memory database, so a store that cannot open its file still runs its SQL.
 */
import { SqliteConnection } from '../index';
import type { BindOptions } from '../define_sqlite_store';
export declare function getOpenSqliteConnections(): Array<{
    name: string;
    conn: SqliteConnection;
}>;
/**
 * Closes a connection's handles and forgets it. Best effort per handle: a handle that will not close is one this
 * process cannot hand back either way, and the report that follows a failed bind is the one worth keeping.
 */
export declare function closeNitroConnection(name: string): void;
export interface NitroConnectionOptions {
    dedicatedReader?: boolean;
    /**
     * Leaves the native JSON shred off the connection, so a table ingests through its JS row builders instead. For a
     * remote switch: the shred is native code on every ingest, and a payload it mishandles has no other remedy.
     */
    shredInJs?: boolean;
}
export declare function openNitroConnection(name: string, opts?: NitroConnectionOptions): SqliteConnection;
interface BindableStore {
    bindSqlite: (conn: SqliteConnection, options?: BindOptions) => void;
}
/**
 * Opens the in-memory database a store falls back to: a scratch database beside `dbName`, whose temp schema holds the
 * store's tables in memory. It has no dedicated reader, since a temp table belongs to the one connection that made it.
 */
export declare function openNitroMemoryFallback(dbName: string, opts?: Pick<NitroConnectionOptions, 'shredInJs'>): SqliteConnection;
export interface BindSqliteStoreOptions extends NitroConnectionOptions {
    /** Runs the store on its in-memory database and never touches the file: what the kill switch asks for. */
    inMemory?: boolean;
}
/**
 * Opens `dbName` and binds `store` to it. A database that will not open or migrate is retried once from empty, since
 * it is only a cache and a damaged file is the likeliest reason; a store that still cannot bind runs on its in-memory
 * database until {@link retrySqliteStores} brings it back. Once bound, a failure mid-session reopens the database, and
 * then moves the store to the same in-memory database.
 */
export declare function bindSqliteStore(label: string, dbName: string, store: BindableStore, opts?: BindSqliteStoreOptions): void;
/**
 * Tries every store that is off its database file — one whose bind failed, or that left the file mid-session — on
 * the file again. For the app to call on returning to the foreground: a launch in the background, before the device's
 * first unlock after a restart, is one where the database cannot be opened and later can.
 */
export declare function retrySqliteStores(): void;
export {};
//# sourceMappingURL=nitro_connection.d.ts.map