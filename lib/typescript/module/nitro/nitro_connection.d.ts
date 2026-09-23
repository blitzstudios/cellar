/**
 * The kernel's {@link SqliteConnection} over `react-native-nitro-sqlite`: it opens the database on device, applies the
 * pragmas a store depends on, narrows JS values to what the JSI bridge binds, and routes a native shred through the
 * sentinel the fork's C++ matches. Every failure here degrades rather than throws, so a store that cannot get
 * SQLite keeps running on an in-memory table.
 */
import { SqliteConnection } from '../index';
import type { SqliteRecovery } from '../define_sqlite_store';
export declare function getOpenSqliteConnections(): Array<{
    name: string;
    conn: SqliteConnection;
}>;
/**
 * Closes a connection's handles and forgets it. Best effort per handle: a handle that will not close is one this
 * process cannot hand back either way, and the report that follows a failed bind is the one worth keeping.
 */
export declare function closeNitroConnection(name: string): void;
export declare function openNitroConnection(name: string, opts?: {
    dedicatedReader?: boolean;
}): SqliteConnection;
interface BindableStore {
    bindSqlite: (conn: SqliteConnection, recovery?: SqliteRecovery) => void;
    moveToSqlite: (conn: SqliteConnection, recovery?: SqliteRecovery) => void;
}
/**
 * Opens `dbName` and moves `store` onto it. A database that will not open or migrate is retried once from empty, since
 * it is only a cache and a damaged file is the likeliest reason; a store that still cannot bind stays on its in-memory
 * table until {@link retrySqliteStores}. Once bound, a failure mid-session reopens the database before giving up on it.
 */
export declare function bindSqliteStore(label: string, dbName: string, store: BindableStore, opts?: {
    dedicatedReader?: boolean;
}): void;
/**
 * Tries every store running on an in-memory table — one whose bind failed, or that gave up on SQLite mid-session — on
 * its database again. For the app to call on returning to the foreground: a launch in the background, before the
 * device's first unlock after a restart, is one where the database cannot be opened and later can.
 */
export declare function retrySqliteStores(): void;
export {};
//# sourceMappingURL=nitro_connection.d.ts.map