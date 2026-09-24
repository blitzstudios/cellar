/** The row table on SQLite: rows live in the database, and become JS objects at the moment a read materializes them. */
import { RowShape, RowTable, RowTableSchema } from './types';
import { NativeShredSpec } from '../write/shred_spec';
import { SqliteConnection } from './connection';
/** Options for {@link createSqliteRowTable}. */
export interface SqliteRowTableOptions {
    /**
     * Creates the table, its indexes and its ETag table as `TEMP` tables, held in memory and starting empty each
     * launch. A temp table is visible only to its own connection, so it is never read through a separate reader.
     */
    temporary?: boolean;
}
/**
 * Creates a {@link RowTable} backed by a SQLite table. Rows stay in SQLite, and only the ones a read selects become JS
 * objects. `defineSqliteStore` creates one when a store is bound. Call its `init` before anything else, which creates
 * the table or rebuilds an outdated one.
 */
export declare function createSqliteRowTable<Row extends RowShape>(schema: RowTableSchema<Row>, conn: SqliteConnection, nativeShredSpec?: NativeShredSpec, options?: SqliteRowTableOptions): RowTable<Row>;
//# sourceMappingURL=sqlite.d.ts.map