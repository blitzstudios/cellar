"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.guardedConnection = guardedConnection;
exports.pinnedReader = pinnedReader;
exports.readRows = readRows;
exports.runBatch = runBatch;
exports.runBatchAsync = runBatchAsync;
/** The seam between the stores and whatever SQLite driver the platform provides. */

/**
 * What one statement hands back: the rows under `rows._array`, and `dispose` to release the result's C++ backing. You
 * build one when adapting a driver; a caller reading rows goes through {@link readRows}, which unwraps and disposes.
 */

/**
 * Everything the kernel asks of a platform's SQLite binding, and the type a driver adapter implements. Only `execute`
 * is required: every optional member is an acceleration its caller has a fallback for, so a store runs over a
 * connection that offers nothing but the one method.
 */

/** A connection {@link readRows} uses exactly as given, so a connection-local `TEMP` table stays visible. */

/** Pins reads to a single handle: the connection's reader when it has one, and otherwise the connection itself. */
function pinnedReader(conn) {
  return conn.reader ?? {
    ...conn,
    reader: undefined
  };
}

/** One statement and its binds: the unit {@link runBatch} takes, and what a row table builds its deletes and inserts as. */

/**
 * Runs `commands` as one transaction, which is what makes a delete-then-insert replacement all-or-nothing. It holds
 * the JS thread for the length of the write, so anything ingest-sized wants {@link runBatchAsync} instead.
 */
function runBatch(conn, commands) {
  if (conn.executeBatch) {
    conn.executeBatch(commands);
    return;
  }
  conn.execute('BEGIN;');
  try {
    for (const [sql, params] of commands) conn.execute(sql, params);
    conn.execute('COMMIT;');
  } catch (error) {
    conn.execute('ROLLBACK;');
    throw error;
  }
}

/**
 * The same transaction handed to the driver's async batch, for a write big enough to drop a frame — an ingest's insert
 * chunks. A driver without one runs it synchronously, so awaiting this is not on its own a promise that JS yielded.
 */
async function runBatchAsync(conn, commands) {
  if (conn.executeBatchAsync) {
    await conn.executeBatchAsync(commands);
    return;
  }
  runBatch(conn, commands);
}
const EMPTY_RESULT = {
  rows: {
    _array: []
  }
};

/** Wraps `conn` so every statement returns: the first failure calls `onFatal`, and later calls answer empty. */
function guardedConnection(conn, onFatal) {
  let failed = false;
  const trip = (error, op) => {
    if (__DEV__) throw error;
    if (failed) return;
    failed = true;
    onFatal(error, op);
  };
  function guard(op, run, benign) {
    if (failed) return benign;
    try {
      return run();
    } catch (error) {
      trip(error, op);
      return benign;
    }
  }
  async function guardAsync(op, run, benign) {
    if (failed) return benign;
    try {
      return await run();
    } catch (error) {
      trip(error, op);
      return benign;
    }
  }
  const guarded = {
    execute: (sql, params) => guard('execute', () => conn.execute(sql, params), EMPTY_RESULT),
    executeBatch: conn.executeBatch && (commands => guard('executeBatch', () => conn.executeBatch(commands), undefined)),
    executeAsync: conn.executeAsync && ((sql, params) => guardAsync('executeAsync', () => conn.executeAsync(sql, params), EMPTY_RESULT)),
    executeBatchAsync: conn.executeBatchAsync && (commands => guardAsync('executeBatchAsync', () => conn.executeBatchAsync(commands), undefined)),
    // Resolves 0, which ends the ingest here; `shred`'s JS-parse fallback belongs to a shred that threw.
    shredJsonArrayAsync: conn.shredJsonArrayAsync && ((spec, rawJson, binds) => guardAsync('shredJsonArrayAsync', () => conn.shredJsonArrayAsync(spec, rawJson, binds), 0)),
    reader: conn.reader && {
      execute: (sql, params) => guard('reader.execute', () => conn.reader.execute(sql, params), EMPTY_RESULT),
      reader: undefined
    }
  };
  return guarded;
}

/**
 * Runs a `SELECT` and hands back its rows as plain JS objects, which is how everything in this layer reads a database.
 * Reads go to the connection's dedicated reader handle wherever there is one, so a statement that depends on
 * connection-local state — a `TEMP` table the caller just created — has to be issued against a {@link PinnedConnection}.
 */
function readRows(conn, sql, params) {
  const result = (conn.reader ?? conn).execute(sql, params);
  const rows = result.rows?._array ?? [];
  // The native result's C++ backing counts against Hermes' external memory until its wrapper is collected.
  result.dispose?.();
  return rows;
}
//# sourceMappingURL=connection.js.map