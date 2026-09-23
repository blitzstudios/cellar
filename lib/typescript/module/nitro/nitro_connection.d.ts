/**
 * The kernel's {@link SqliteConnection} over `react-native-nitro-sqlite`: it opens the database on device, applies the
 * pragmas a store depends on, narrows JS values to what the JSI bridge binds, and routes a native shred through the
 * sentinel the fork's C++ matches. Every failure here degrades rather than throws, so a store that cannot get
 * SQLite keeps running on an in-memory table.
 */
import { SqliteConnection } from '../index';
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
/** Opens `dbName` and moves `store` onto it, or leaves the store on its in-memory table and reports why. */
export declare function bindSqliteStore(label: string, dbName: string, store: {
    bindSqlite: (conn: SqliteConnection) => void;
}, opts?: {
    dedicatedReader?: boolean;
}): void;
//# sourceMappingURL=nitro_connection.d.ts.map