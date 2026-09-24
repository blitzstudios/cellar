"use strict";

/** A row table for a test: SQLite over a fresh sql.js database, built and ready. */

import { createSqliteRowTable } from "../table/sqlite.js";
import { createSqlJsConnection } from "./sqljs_connection.js";

/**
 * Creates a table on a new sql.js database with every optional connection method, so a test runs the device's code
 * paths.
 */
export function createTestRowTable(schema, nativeShredSpec) {
  return createTestRowTableWithConnection(schema, nativeShredSpec).table;
}

/** Like {@link createTestRowTable}, also returning the connection, for a test that inspects the SQL run. */
export function createTestRowTableWithConnection(schema, nativeShredSpec) {
  const conn = createSqlJsConnection({
    capabilities: 'full'
  });
  const table = createSqliteRowTable(schema, conn, nativeShredSpec);
  table.init();
  return {
    table,
    conn
  };
}
//# sourceMappingURL=row_table.js.map