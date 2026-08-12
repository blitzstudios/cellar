/** The row table on SQLite: rows live in the database, and become JS objects at the moment a read materializes them. */
import { RowShape, RowTable, RowTableSchema } from './types';
import { NativeShredSpec } from '../write/shred_spec';
import { SqliteConnection } from './connection';
/**
 * The {@link RowTable} over a real database, and the point of the whole layer: the rows stay in SQLite, and only the
 * ones a read selects are ever built as JS objects. `defineSqliteStore` constructs one once a connection is bound, and
 * its `init` has to run before any other call, since that is what creates the table or rebuilds a stale one.
 */
export declare function createSqliteRowTable<Row extends RowShape>(schema: RowTableSchema<Row>, conn: SqliteConnection, nativeShredSpec?: NativeShredSpec): RowTable<Row>;
//# sourceMappingURL=sqlite.d.ts.map