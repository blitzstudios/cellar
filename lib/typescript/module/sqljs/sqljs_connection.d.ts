/**
 * A store's SQLite on the web: sql.js, the same engine compiled to WebAssembly, with each store's database held in
 * memory for the life of the page. The app loads sql.js and hands the module in, so nothing here reaches for a file
 * or a URL, and nothing bundled for a device ever imports it.
 */
import type { BindOptions } from '../define_sqlite_store';
import type { SqliteConnection } from '../table/connection';
interface SqlJsStatement {
    bind(params: Array<string | number | null>): void;
    step(): boolean;
    getAsObject(): unknown;
    free(): void;
}
interface SqlJsDatabase {
    prepare(sql: string): SqlJsStatement;
}
/** What `initSqlJs()` resolves to: the engine, from which each store opens a database of its own. */
export interface SqlJsModule {
    Database: new () => SqlJsDatabase;
}
interface BindableStore {
    bindSqlite: (conn: SqliteConnection, options?: BindOptions) => void;
}
/** A connection over a fresh in-memory database. Synchronous underneath, so the async methods only wrap it. */
export declare function openSqlJsConnection(SQL: SqlJsModule): SqliteConnection;
/** Binds `store` to a database of its own; a failure is reported and leaves the store reading empty rather than throwing. */
export declare function bindSqlJsStore(label: string, SQL: SqlJsModule, store: BindableStore): void;
export {};
//# sourceMappingURL=sqljs_connection.d.ts.map