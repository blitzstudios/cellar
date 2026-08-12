"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.bindSqliteBackend = bindSqliteBackend;
exports.bindSqliteStore = bindSqliteStore;
exports.getOpenSqliteConnections = getOpenSqliteConnections;
exports.openNitroConnection = openNitroConnection;
var _reactNativeNitroSqlite = require("react-native-nitro-sqlite");
var _index = require("../index.js");
/**
 * The kernel's {@link SqliteConnection} over `react-native-nitro-sqlite`: it opens the database on device, applies the
 * pragmas a store depends on, narrows JS values to what the JSI bridge binds, and routes a native shred through the
 * sentinel the fork's C++ matches. Every failure here degrades rather than throws, so a store that cannot get its
 * SQLite backend keeps running on the in-memory one.
 */

/** Matched verbatim by `sqliteExecute` in our `react-native-nitro-sqlite` fork (`cpp/shred.cpp`). */
const NITRO_SHRED_SENTINEL = '-- nitro_shred_v1';
function toNativeParams(params) {
  if (!params) return undefined;
  return params.map(value => {
    if (value == null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string' || typeof value === 'number') return value;
    return JSON.stringify(value);
  });
}
const openConnections = new Map();
function getOpenSqliteConnections() {
  return Array.from(openConnections, ([name, conn]) => ({
    name,
    conn
  }));
}
const PRAGMAS = [{
  sql: 'PRAGMA journal_mode=WAL;',
  cost: 'DB stays on the slower default journal mode'
}, {
  sql: 'PRAGMA synchronous=NORMAL;',
  cost: 'writes fsync more often than they need to'
}, {
  sql: 'PRAGMA busy_timeout=5000;',
  cost: 'a contended write throws SQLITE_BUSY instead of waiting for the lock'
}, {
  sql: 'PRAGMA temp_store=MEMORY;',
  cost: "the ranker's temp tables can spill to a file instead of staying resident"
},
// Negative is KiB, and caps rather than reserves.
{
  sql: 'PRAGMA cache_size=-8000;',
  cost: "the page cache stays at SQLite's 2MB default, so bulk ingests re-read index pages"
}];
function applyPragmas(conn, name) {
  for (const pragma of PRAGMAS) {
    try {
      conn.execute(pragma.sql);
    } catch (error) {
      (0, _index.reportStoreDegradation)({
        scope: `nitro_connection.pragma.${name}`,
        context: `failed to apply \`${pragma.sql}\` — ${pragma.cost}`,
        error,
        extra: {
          connection: name,
          pragma: pragma.sql
        }
      });
    }
  }
}
function adaptHandle(conn) {
  return {
    execute: (sql, params) => conn.execute(sql, toNativeParams(params)),
    executeBatch: commands => {
      conn.executeBatch(commands.map(([query, params]) => ({
        query,
        params: toNativeParams(params)
      })));
    },
    executeAsync: (sql, params) => conn.executeAsync(sql, toNativeParams(params)),
    executeBatchAsync: async commands => {
      await conn.executeBatchAsync(commands.map(([query, params]) => ({
        query,
        params: toNativeParams(params)
      })));
    },
    shredJsonArrayAsync: async (spec, rawJson, scopeBinds) => {
      const params = toNativeParams([JSON.stringify(spec), rawJson, ...scopeBinds]);
      const result = await conn.executeAsync(NITRO_SHRED_SENTINEL, params);
      const rowsAffected = result?.rowsAffected;
      return typeof rowsAffected === 'number' ? rowsAffected : 0;
    }
  };
}
function openNitroConnection(name, opts) {
  const writer = (0, _reactNativeNitroSqlite.open)({
    name
  });
  applyPragmas(writer, name);
  let reader;
  if (opts?.dedicatedReader) {
    const handle = `${name}:reader`;
    try {
      const readHandle = (0, _reactNativeNitroSqlite.openSecondary)({
        name,
        handle
      });
      applyPragmas(readHandle, handle);
      reader = adaptHandle(readHandle);
    } catch (error) {
      (0, _index.reportStoreDegradation)({
        scope: `nitro_connection.reader.${name}`,
        context: 'failed to open the dedicated reader handle — reads share the writer handle, and may contend with ingests',
        error,
        extra: {
          connection: name
        }
      });
    }
  }
  const adapted = {
    ...adaptHandle(writer),
    reader
  };
  openConnections.set(name, adapted);
  return adapted;
}
function bindSqliteBackend(label, bind) {
  try {
    bind();
  } catch (error) {
    (0, _index.reportStoreDegradation)({
      scope: `nitro_connection.bind.${label}`,
      context: 'failed to bind the SQLite backend — the store stays on its in-memory backend, so its working set is on the JS heap for this session',
      error,
      extra: {
        label
      }
    });
  }
}
function bindSqliteStore(label, dbName, setBackend, createSqliteBackend, opts) {
  bindSqliteBackend(label, () => setBackend(createSqliteBackend(openNitroConnection(dbName, opts))));
}
//# sourceMappingURL=nitro_connection.js.map