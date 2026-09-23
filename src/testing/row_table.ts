/** A row table for a test: SQLite over a fresh sql.js database, built and ready. */

import { RowShape, RowTable, RowTableSchema } from '../table/types';
import { createSqliteRowTable } from '../table/sqlite';
import { NativeShredSpec } from '../write/shred_spec';
import { createSqlJsConnection, SqlJsConnection } from './sqljs_connection';

/** The table over a database of its own, with every optional connection method, so a test runs the device's paths. */
export function createTestRowTable<Row extends RowShape>(schema: RowTableSchema<Row>, nativeShredSpec?: NativeShredSpec): RowTable<Row> {
  return createTestRowTableWithConnection(schema, nativeShredSpec).table;
}

/** The same, with the connection under it, for a test that also builds a store's capabilities or inspects the SQL. */
export function createTestRowTableWithConnection<Row extends RowShape>(
  schema: RowTableSchema<Row>,
  nativeShredSpec?: NativeShredSpec,
): { table: RowTable<Row>; conn: SqlJsConnection } {
  const conn = createSqlJsConnection({ capabilities: 'full' });
  const table = createSqliteRowTable(schema, conn, nativeShredSpec);
  table.init();
  return { table, conn };
}
