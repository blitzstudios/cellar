"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createTestRowTable = createTestRowTable;
exports.createTestRowTableWithConnection = createTestRowTableWithConnection;
var _sqlite = require("../table/sqlite.js");
var _sqljs_connection = require("./sqljs_connection.js");
/** A row table for a test: SQLite over a fresh sql.js database, built and ready. */

/** The table over a database of its own, with every optional connection method, so a test runs the device's paths. */
function createTestRowTable(schema, nativeShredSpec) {
  return createTestRowTableWithConnection(schema, nativeShredSpec).table;
}

/** The same, with the connection under it, for a test that also builds a store's capabilities or inspects the SQL. */
function createTestRowTableWithConnection(schema, nativeShredSpec) {
  const conn = (0, _sqljs_connection.createSqlJsConnection)({
    capabilities: 'full'
  });
  const table = (0, _sqlite.createSqliteRowTable)(schema, conn, nativeShredSpec);
  table.init();
  return {
    table,
    conn
  };
}
//# sourceMappingURL=row_table.js.map