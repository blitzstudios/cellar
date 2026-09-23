/** A row table for a test: SQLite over a fresh sql.js database, built and ready. */
import { RowShape, RowTable, RowTableSchema } from '../table/types';
import { NativeShredSpec } from '../write/shred_spec';
import { SqlJsConnection } from './sqljs_connection';
/** The table over a database of its own, with every optional connection method, so a test runs the device's paths. */
export declare function createTestRowTable<Row extends RowShape>(schema: RowTableSchema<Row>, nativeShredSpec?: NativeShredSpec): RowTable<Row>;
/** The same, with the connection under it, for a test that also builds a store's capabilities or inspects the SQL. */
export declare function createTestRowTableWithConnection<Row extends RowShape>(schema: RowTableSchema<Row>, nativeShredSpec?: NativeShredSpec): {
    table: RowTable<Row>;
    conn: SqlJsConnection;
};
//# sourceMappingURL=row_table.d.ts.map