/** A {@link SqliteConnection} over sql.js: a real SQLite engine in Jest, on a different build than the device's. */
import { SqliteConnection } from '../table/connection';
export declare function initSqlJs(): Promise<void>;
/** `'minimal'` implements `execute` alone, the degraded shape; `'full'` implements every optional method. */
export type SqlJsCapabilities = 'minimal' | 'full';
export interface SqlJsCallLog {
    execute: number;
    executeAsync: number;
    executeBatch: number;
    executeBatchAsync: number;
    shredJsonArrayAsync: number;
    readerExecute: number;
    dispose: number;
}
export interface SqlJsConnection extends SqliteConnection {
    close(): void;
    calls: SqlJsCallLog;
    executed: string[];
}
export interface SqlJsConnectionOptions {
    capabilities?: SqlJsCapabilities;
    /** Makes `dispose()` null out the result's `_array`, modelling a driver that frees its backing. */
    poisonOnDispose?: boolean;
}
export declare function createSqlJsConnection(options?: SqlJsConnectionOptions): SqlJsConnection;
//# sourceMappingURL=sqljs_connection.d.ts.map