/** The seam between the stores and whatever SQLite driver the platform provides. */

import { ShredSpec } from '../write/shred_spec';

/**
 * What one statement hands back: the rows under `rows._array`, and `dispose` to release the result's C++ backing. You
 * build one when adapting a driver; a caller reading rows goes through {@link readRows}, which unwraps and disposes.
 */
export interface QueryExecResult {
  rows?: { _array?: unknown[] };
  dispose?: () => void;
}

/**
 * Everything the kernel asks of a platform's SQLite binding, and the type a driver adapter implements. Only `execute`
 * is required: every optional member is an acceleration its caller has a fallback for, so a store runs over a
 * connection that offers nothing but the one method.
 */
export interface SqliteConnection {
  execute(sql: string, params?: ReadonlyArray<string | number | null>): QueryExecResult;
  executeBatch?(commands: ReadonlyArray<[string, ReadonlyArray<string | number | null>]>): void;
  executeAsync?(sql: string, params?: ReadonlyArray<string | number | null>): Promise<QueryExecResult>;
  executeBatchAsync?(commands: ReadonlyArray<[string, ReadonlyArray<string | number | null>]>): Promise<void>;
  shredJsonArrayAsync?(spec: ShredSpec, rawJson: string, binds: ReadonlyArray<string | number | null>): Promise<number>;
  /** A read-only second handle; nitro-sqlite serializes per handle, so under WAL this one reads during a write. */
  reader?: PinnedConnection;
}

/** A connection {@link readRows} uses exactly as given, so a connection-local `TEMP` table stays visible. */
export type PinnedConnection = SqliteConnection & { readonly reader?: undefined };

/** Pins reads to a single handle: the connection's reader when it has one, and otherwise the connection itself. */
export function pinnedReader(conn: SqliteConnection): PinnedConnection {
  return conn.reader ?? { ...conn, reader: undefined };
}

/** One statement and its binds: the unit {@link runBatch} takes, and what a row table builds its deletes and inserts as. */
export type BatchCommand = [string, ReadonlyArray<string | number | null>];

/**
 * Runs `commands` as one transaction, which is what makes a delete-then-insert replacement all-or-nothing. It holds
 * the JS thread for the length of the write, so anything ingest-sized wants {@link runBatchAsync} instead.
 */
export function runBatch(conn: SqliteConnection, commands: ReadonlyArray<BatchCommand>): void {
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
export async function runBatchAsync(conn: SqliteConnection, commands: ReadonlyArray<BatchCommand>): Promise<void> {
  if (conn.executeBatchAsync) {
    await conn.executeBatchAsync(commands);
    return;
  }
  runBatch(conn, commands);
}

const EMPTY_RESULT: QueryExecResult = { rows: { _array: [] } };

/** Wraps `conn` so every statement returns: the first failure calls `onFatal`, and later calls answer empty. */
export function guardedConnection(conn: SqliteConnection, onFatal: (error: unknown, op: string) => void): SqliteConnection {
  let failed = false;

  const trip = (error: unknown, op: string): void => {
    if (__DEV__) throw error;
    if (failed) return;
    failed = true;
    onFatal(error, op);
  };

  function guard<T>(op: string, run: () => T, benign: T): T {
    if (failed) return benign;
    try {
      return run();
    } catch (error) {
      trip(error, op);
      return benign;
    }
  }

  async function guardAsync<T>(op: string, run: () => Promise<T>, benign: T): Promise<T> {
    if (failed) return benign;
    try {
      return await run();
    } catch (error) {
      trip(error, op);
      return benign;
    }
  }

  const guarded: SqliteConnection = {
    execute: (sql, params) => guard('execute', () => conn.execute(sql, params), EMPTY_RESULT),
    executeBatch: conn.executeBatch && ((commands) => guard('executeBatch', () => conn.executeBatch!(commands), undefined)),
    executeAsync: conn.executeAsync && ((sql, params) => guardAsync('executeAsync', () => conn.executeAsync!(sql, params), EMPTY_RESULT)),
    executeBatchAsync: conn.executeBatchAsync && ((commands) => guardAsync('executeBatchAsync', () => conn.executeBatchAsync!(commands), undefined)),
    // Resolves 0, which ends the ingest here; `shred`'s JS-parse fallback belongs to a shred that threw.
    shredJsonArrayAsync:
      conn.shredJsonArrayAsync && ((spec, rawJson, binds) => guardAsync('shredJsonArrayAsync', () => conn.shredJsonArrayAsync!(spec, rawJson, binds), 0)),
    reader: conn.reader && {
      execute: (sql, params) => guard('reader.execute', () => conn.reader!.execute(sql, params), EMPTY_RESULT),
      reader: undefined,
    },
  };
  return guarded;
}

/**
 * Runs a `SELECT` and hands back its rows as plain JS objects, which is how everything in this layer reads a database.
 * Reads go to the connection's dedicated reader handle wherever there is one, so a statement that depends on
 * connection-local state — a `TEMP` table the caller just created — has to be issued against a {@link PinnedConnection}.
 */
export function readRows<T>(conn: SqliteConnection, sql: string, params?: ReadonlyArray<string | number | null>): T[] {
  const result = (conn.reader ?? conn).execute(sql, params);
  const rows = (result.rows?._array ?? []) as T[];
  // The native result's C++ backing counts against Hermes' external memory until its wrapper is collected.
  result.dispose?.();
  return rows;
}
