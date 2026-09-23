/** The row table on SQLite: rows live in the database, and become JS objects at the moment a read materializes them. */
import { RowShape, RowTable, RowTableSchema } from './types';
import { NativeShredSpec } from '../write/shred_spec';
import { SqliteConnection } from './connection';
export interface SqliteRowTableOptions {
    /**
     * Builds the table, its indexes and its ETag table in the connection's temp schema, which `temp_store = MEMORY` keeps
     * in memory. Every statement names the table unqualified, and SQLite looks a name up in the temp schema first, so
     * nothing else changes. A temp table belongs to one connection and starts empty, so it has no dedicated reader and
     * no migration.
     */
    temporary?: boolean;
}
/**
 * The {@link RowTable} over a real database, and the point of the whole layer: the rows stay in SQLite, and only the
 * ones a read selects are ever built as JS objects. `defineSqliteStore` constructs one once a connection is bound, and
 * its `init` has to run before any other call, since that is what creates the table or rebuilds a stale one.
 */
export declare function createSqliteRowTable<Row extends RowShape>(schema: RowTableSchema<Row>, conn: SqliteConnection, nativeShredSpec?: NativeShredSpec, options?: SqliteRowTableOptions): RowTable<Row>;
//# sourceMappingURL=sqlite.d.ts.map