"use strict";

/**
 * A store's SQLite on the web: sql.js, the same engine compiled to WebAssembly, with each store's database held in
 * memory for the life of the page. The app loads sql.js and hands the module in, so nothing here reaches for a file
 * or a URL, and nothing bundled for a device ever imports it.
 */

import { reportStoreDegradation } from "../diagnostics/telemetry.js";

/** What `initSqlJs()` resolves to: the engine, from which each store opens a database of its own. */

/** A connection over a fresh in-memory database. Synchronous underneath, so the async methods only wrap it. */
export function openSqlJsConnection(SQL) {
  const db = new SQL.Database();
  const run = (sql, params) => {
    const statement = db.prepare(sql);
    try {
      statement.bind((params ?? []).map(param => param === undefined ? null : param));
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return {
        rows: {
          _array: rows
        }
      };
    } finally {
      statement.free();
    }
  };
  const batch = commands => {
    run('BEGIN;');
    try {
      for (const [sql, params] of commands) run(sql, params);
      run('COMMIT;');
    } catch (error) {
      run('ROLLBACK;');
      throw error;
    }
  };
  return {
    execute: run,
    executeAsync: async (sql, params) => run(sql, params),
    executeBatch: batch,
    executeBatchAsync: async commands => batch(commands)
  };
}

/** Binds `store` to a database of its own; a failure is reported and leaves the store reading empty rather than throwing. */
export function bindSqlJsStore(label, SQL, store) {
  try {
    store.bindSqlite(openSqlJsConnection(SQL));
  } catch (error) {
    reportStoreDegradation({
      scope: `sqljs.bind.${label}`,
      context: 'failed to bind the store to sql.js; its reads are empty for the life of the page',
      error,
      extra: {
        label
      }
    });
  }
}
//# sourceMappingURL=sqljs_connection.js.map