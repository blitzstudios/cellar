/**
 * The kernel's {@link SqliteConnection} over `react-native-nitro-sqlite`: it opens the database on device, applies the
 * pragmas a store depends on, narrows JS values to what the JSI bridge binds, and routes a native shred through the
 * sentinel the fork's C++ matches. Every failure here degrades rather than throws, so a store that cannot get its
 * SQLite backend keeps running on the in-memory one.
 */
import { SqliteConnection } from '../index';
export declare function getOpenSqliteConnections(): Array<{
    name: string;
    conn: SqliteConnection;
}>;
export declare function openNitroConnection(name: string, opts?: {
    dedicatedReader?: boolean;
}): SqliteConnection;
export declare function bindSqliteBackend(label: string, bind: () => void): void;
export declare function bindSqliteStore<Backend>(label: string, dbName: string, setBackend: (backend: Backend) => void, createSqliteBackend: (conn: SqliteConnection) => Backend, opts?: {
    dedicatedReader?: boolean;
}): void;
//# sourceMappingURL=nitro_connection.d.ts.map