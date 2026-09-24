/** A row table for a test: SQLite over a fresh sql.js database, built and ready. */
import { RowShape, RowTable, RowTableSchema } from '../table/types';
import { NativeShredSpec } from '../write/shred_spec';
import { SqlJsConnection } from './sqljs_connection';
/**
 * Creates a table on a new sql.js database with every optional connection method, so a test runs the device's code
 * paths.
 */
export declare function createTestRowTable<Row extends RowShape>(schema: RowTableSchema<Row>, nativeShredSpec?: NativeShredSpec): RowTable<Row>;
/** Like {@linkcode createTestRowTable}, also returning the connection, for a test that inspects the SQL run. */
export declare function createTestRowTableWithConnection<Row extends RowShape>(schema: RowTableSchema<Row>, nativeShredSpec?: NativeShredSpec): {
    /** The table. */
    table: RowTable<Row>;
    /** Its connection. */
    conn: SqlJsConnection;
};
//# sourceMappingURL=row_table.d.ts.map