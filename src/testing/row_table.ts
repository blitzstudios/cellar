/** A row table for a test: SQLite over a fresh sql.js database, built and ready. */

import { RowShape, RowTable, RowTableSchema } from '../table/types';
import { createSqliteRowTable } from '../table/sqlite';
import { NativeShredSpec } from '../write/shred_spec';
import { createSqlJsConnection, SqlJsConnection } from './sqljs_connection';

/**
 * Creates a table on a new sql.js database with every optional connection method, so a test runs the device's code
 * paths.
 */
export function createTestRowTable<Row extends RowShape>(schema: RowTableSchema<Row>, nativeShredSpec?: NativeShredSpec): RowTable<Row> {
  return createTestRowTableWithConnection(schema, nativeShredSpec).table;
}

/** Like {@link createTestRowTable}, also returning the connection, for a test that inspects the SQL run. */
export function createTestRowTableWithConnection<Row extends RowShape>(
  schema: RowTableSchema<Row>,
  nativeShredSpec?: NativeShredSpec,
): {
  /** The table. */
  table: RowTable<Row>;
  /** Its connection. */
  conn: SqlJsConnection;
} {
  const conn = createSqlJsConnection({ capabilities: 'full' });
  const table = createSqliteRowTable(schema, conn, nativeShredSpec);
  table.init();
  return { table, conn };
}
