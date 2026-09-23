"use strict";

/**
 * The kernel's {@link SqliteConnection} over `react-native-nitro-sqlite`: it opens the database on device, applies the
 * pragmas a store depends on, narrows JS values to what the JSI bridge binds, and routes a native shred through the
 * sentinel the fork's C++ matches. Every failure here degrades rather than throws, so a store that cannot get
 * SQLite keeps running on an in-memory table.
 */

import { NitroSQLite, open, openSecondary } from 'react-native-nitro-sqlite';
import { reportStoreDegradation } from "../index.js";

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
export function getOpenSqliteConnections() {
  return Array.from(openConnections, ([name, entry]) => ({
    name,
    conn: entry.conn
  }));
}

/**
 * Closes a connection's handles and forgets it. Best effort per handle: a handle that will not close is one this
 * process cannot hand back either way, and the report that follows a failed bind is the one worth keeping.
 */
export function closeNitroConnection(name) {
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
      reportStoreDegradation({
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

/**
 * Shred specs already serialized. A store hands the same spec object to every ingest of a partition variant, and the
 * spec describes the schema rather than the body, so serializing it per call re-encodes a constant.
 */
const serializedSpecs = new WeakMap();
function serializeSpec(spec) {
  const cached = serializedSpecs.get(spec);
  if (cached !== undefined) {
    // Caching on identity assumes a spec is never edited after its first ingest. Nothing freezes them, so in dev the
    // assumption is checked rather than trusted: silently shredding against a stale spec writes the wrong columns.
    if (__DEV__ && JSON.stringify(spec) !== cached) {
      throw new Error(`nitro_connection: shred spec for '${spec.table}' was mutated after it was first serialized`);
    }
    return cached;
  }
  const json = JSON.stringify(spec);
  serializedSpecs.set(spec, json);
  return json;
}

/**
 * A batch command's params are either one bind list or a list of them, and nitro decodes an empty array as the list of
 * lists: zero executions, so the statement is silently dropped. A statement with nothing to bind has to send none.
 */
const toBatchCommand = ([query, params]) => ({
  query,
  params: params?.length ? toNativeParams(params) : undefined
});
function adaptHandle(conn) {
  return {
    execute: (sql, params) => conn.execute(sql, toNativeParams(params)),
    executeBatch: commands => {
      conn.executeBatch(commands.map(toBatchCommand));
    },
    executeAsync: (sql, params) => conn.executeAsync(sql, toNativeParams(params)),
    executeBatchAsync: async commands => {
      await conn.executeBatchAsync(commands.map(toBatchCommand));
    },
    shredJsonArrayAsync: async (spec, rawJson, scopeBinds) => {
      const params = toNativeParams([serializeSpec(spec), rawJson, ...scopeBinds]);
      const result = await conn.executeAsync(NITRO_SHRED_SENTINEL, params);
      const rowsAffected = result?.rowsAffected;
      return typeof rowsAffected === 'number' ? rowsAffected : 0;
    }
  };
}

/** A handle name nitro still holds is reported this way; the message is the only thing that distinguishes it. */
function isHandleInUse(error) {
  return String(error?.message ?? error).includes('is already in use');
}

/**
 * Opens `name`'s dedicated reader, reclaiming the handle if a previous JS runtime left it open.
 *
 * {@link closeNitroConnection} can only hand back handles this module's own map knows about, and that map lives in the
 * JS heap. An iOS CodePush reload replaces the JS runtime in the same native process, so the new runtime starts with an
 * empty map while nitro's registry still holds every handle the old one opened. The writer survives that, because
 * `open` addresses a database by name and re-registers it; a secondary handle's name is exclusive, so the reader is the
 * one that collides.
 *
 * Losing it is not the small thing it reads as. `readRows` falls back to the writer handle, so the ranker's multi
 * statement `TEMP` work starts interleaving with an ingest's savepoint on one connection, SQLite refuses the nested
 * transaction, and the first refusal degrades the whole store onto an in-memory table — the entire working set back
 * on the JS heap. So this tries hard: close the stale handle by name and retry, and failing that take a unique name,
 * which cannot collide with anything.
 */
function openReader(name) {
  const preferred = `${name}:reader`;
  try {
    return openSecondary({
      name,
      handle: preferred
    });
  } catch (error) {
    if (!isHandleInUse(error)) throw error;
  }

  // Addressed by name, which is how nitro identifies a connection — holding the original object is not required, and
  // after a reload there is no object to hold.
  try {
    NitroSQLite.native.close(preferred);
    return openSecondary({
      name,
      handle: preferred
    });
  } catch {
    /* the stale handle would not close, or the retry lost the same race; fall through to a name of our own */
  }
  return openSecondary({
    name,
    handle: `${preferred}:${Date.now().toString(36)}`
  });
}
export function openNitroConnection(name, opts) {
  // Reopening a database this process already holds — a Fast Refresh re-running init, or a store rebound after a
  // schema change — has to hand the previous handles back first. Registering over them would leak them, and because a
  // secondary handle's name is exclusive, the reader is the one that would not come back.
  closeNitroConnection(name);
  const writer = open({
    name
  });
  applyPragmas(writer, name);
  const handles = [writer];
  let reader;
  if (opts?.dedicatedReader) {
    try {
      const readHandle = openReader(name);
      if (readHandle) {
        applyPragmas(readHandle, `${name}:reader`);
        reader = adaptHandle(readHandle);
        handles.push(readHandle);
      }
    } catch (error) {
      reportStoreDegradation({
        scope: `nitro_connection.reader.${name}`,
        context: 'failed to open the dedicated reader handle — reads fall back to the writer, where a read that needs a transaction can collide ' + 'with an ingest and degrade the store onto an in-memory table',
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
function guardedBind(label, bind) {
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
    reportStoreDegradation({
      scope: `nitro_connection.bind.${label}`,
      context: 'failed to bind SQLite — the store stays on an in-memory table, so its working set is on the JS heap for this session',
      error,
      extra: {
        label
      }
    });
  } finally {
    openedDuringBind = outer;
  }
}

/** Opens `dbName` and moves `store` onto it, or leaves the store on its in-memory table and reports why. */
export function bindSqliteStore(label, dbName, store, opts) {
  guardedBind(label, () => store.bindSqlite(openNitroConnection(dbName, opts)));
}
//# sourceMappingURL=nitro_connection.js.map