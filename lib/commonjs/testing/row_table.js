"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createTestRowTable = createTestRowTable;
exports.createTestRowTableWithConnection = createTestRowTableWithConnection;
var _sqlite = require("../table/sqlite.js");
var _sqljs_connection = require("./sqljs_connection.js");
/** A row table for a test: SQLite over a fresh sql.js database, built and ready. */

/**
 * Creates a table on a new sql.js database with every optional connection method, so a test runs the device's code
 * paths.
 */
function createTestRowTable(schema, nativeShredSpec) {
  return createTestRowTableWithConnection(schema, nativeShredSpec).table;
}

/** Like {@linkcode createTestRowTable}, also returning the connection, for a test that inspects the SQL run. */
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