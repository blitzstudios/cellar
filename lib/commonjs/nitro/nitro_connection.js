"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.bindSqliteBackend = bindSqliteBackend;
exports.bindSqliteStore = bindSqliteStore;
exports.closeNitroConnection = closeNitroConnection;
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

/** Every connection this module has open, with the handles to close it by: nitro addresses a handle by name, not by object. */
const openConnections = new Map();
function getOpenSqliteConnections() {
  return Array.from(openConnections, ([name, entry]) => ({
    name,
    conn: entry.conn
  }));
}

/**
 * Closes a connection's handles and forgets it. Best effort per handle: a handle that will not close is one this
 * process cannot hand back either way, and the report that follows a failed bind is the one worth keeping.
 */
function closeNitroConnection(name) {
  const entry = openConnections.get(name);
  if (!entry) return;
  openConnections.delete(name);
  for (const handle of entry.handles) {
    try {
      handle.close();
    } catch {
      /* already gone, or never opened */
    }
  }
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
  const handles = [writer];
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
      handles.push(readHandle);
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
  openConnections.set(name, {
    conn: adapted,
    handles
  });
  openedDuringBind?.add(name);
  return adapted;
}

/**
 * Names opened by the bind currently running, tracked by what this attempt opened rather than by what was already
 * registered: a store re-initializing — a retry, or a Fast Refresh — opens a name that is *also* the one it held
 * before, and comparing registries would take that for a connection someone else owns and leave it open.
 */
let openedDuringBind;
function bindSqliteBackend(label, bind) {
  const outer = openedDuringBind;
  const opened = new Set();
  openedDuringBind = opened;
  try {
    bind();
  } catch (error) {
    // A half-bound store would otherwise keep its handles for the life of the process, and a secondary handle's name is
    // exclusive: whatever opens next could not have its reader back, and would report a handle collision on top of the
    // failure that actually happened.
    for (const name of opened) closeNitroConnection(name);
    (0, _index.reportStoreDegradation)({
      scope: `nitro_connection.bind.${label}`,
      context: 'failed to bind the SQLite backend — the store stays on its in-memory backend, so its working set is on the JS heap for this session',
      error,
      extra: {
        label
      }
    });
  } finally {
    openedDuringBind = outer;
  }
}
function bindSqliteStore(label, dbName, setBackend, createSqliteBackend, opts) {
  bindSqliteBackend(label, () => setBackend(createSqliteBackend(openNitroConnection(dbName, opts))));
}
//# sourceMappingURL=nitro_connection.js.map