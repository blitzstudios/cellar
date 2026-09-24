/** A {@link SqliteConnection} over sql.js for Jest: real SQLite, though a different build from the device's. */
import { SqliteConnection } from '../table/connection';
/** Loads sql.js. Await it in `beforeAll` before creating a connection. */
export declare function initSqlJs(): Promise<void>;
/**
 * Which connection methods a test connection has: `minimal` has only `execute`, and `full` has every optional method.
 */
export type SqlJsCapabilities = 'minimal' | 'full';
/** How many times each connection method has been called. */
export interface SqlJsCallLog {
    execute: number;
    executeAsync: number;
    executeBatch: number;
    executeBatchAsync: number;
    shredJsonArrayAsync: number;
    /** Calls to the reader's `execute`. */
    readerExecute: number;
    /** Calls to a result's `dispose`. */
    dispose: number;
}
/** A test connection, which also records what was called on it. */
export interface SqlJsConnection extends SqliteConnection {
    /** Closes the database. */
    close(): void;
    /** How many times each method has been called. */
    calls: SqlJsCallLog;
    /** Every SQL statement run, in order. */
    executed: string[];
}
/** Options for {@link createSqlJsConnection}. */
export interface SqlJsConnectionOptions {
    /** Which optional methods the connection has; `minimal` by default. */
    capabilities?: SqlJsCapabilities;
    /** Makes a result's `dispose()` clear its rows, like a driver that frees them. */
    poisonOnDispose?: boolean;
}
/** Creates a connection to a new in-memory sql.js database. Requires {@link initSqlJs} to have finished. */
export declare function createSqlJsConnection(options?: SqlJsConnectionOptions): SqlJsConnection;
//# sourceMappingURL=sqljs_connection.d.ts.map