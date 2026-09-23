"use strict";

/** A row table for a test: SQLite over a fresh sql.js database, built and ready. */

import { createSqliteRowTable } from "../table/sqlite.js";
import { createSqlJsConnection } from "./sqljs_connection.js";

/** The table over a database of its own, with every optional connection method, so a test runs the device's paths. */
export function createTestRowTable(schema, nativeShredSpec) {
  return createTestRowTableWithConnection(schema, nativeShredSpec).table;
}

/** The same, with the connection under it, for a test that also builds a store's capabilities or inspects the SQL. */
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