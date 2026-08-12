/** A {@link SqliteConnection} over sql.js: a real SQLite engine in Jest, on a different build than the device's. */

import path from 'path';

import { evalShredSpec } from '../write/shred_spec';
import type { ShredSpec } from '../write/shred_spec';
import { PinnedConnection, QueryExecResult, SqliteConnection } from '../table/connection';

interface SqlJsStatement {
  bind(params: Array<string | number | null>): void;
  step(): boolean;
  getAsObject(): unknown;
  free(): void;
}
interface SqlJsDatabase {
  prepare(sql: string): SqlJsStatement;
  close(): void;
}
interface SqlJsModule {
  Database: new () => SqlJsDatabase;
}
type SqlJsFactory = (config: { locateFile: (file: string) => string }) => Promise<SqlJsModule>;

let SqlModule: SqlJsModule | undefined;

export async function initSqlJs(): Promise<void> {
  if (SqlModule) return;
  // eslint-disable-next-line global-require
  const factory = require('sql.js') as SqlJsFactory;
  const dist = path.dirname(require.resolve('sql.js'));
  SqlModule = await factory({ locateFile: (file: string) => path.join(dist, file) });
}

/** `'minimal'` implements `execute` alone, the degraded shape; `'full'` implements every optional method. */
export type SqlJsCapabilities = 'minimal' | 'full';

export interface SqlJsCallLog {
  execute: number;
  executeAsync: number;
  executeBatch: number;
  executeBatchAsync: number;
  shredJsonArrayAsync: number;
  readerExecute: number;
  dispose: number;
}

export interface SqlJsConnection extends SqliteConnection {
  close(): void;
  calls: SqlJsCallLog;
  executed: string[];
}

export interface SqlJsConnectionOptions {
  capabilities?: SqlJsCapabilities;
  /** Makes `dispose()` null out the result's `_array`, modelling a driver that frees its backing. */
  poisonOnDispose?: boolean;
}

/** Turns every `undefined` bind into `null`, the shape sql.js accepts. */
function sanitize(params?: ReadonlyArray<string | number | null>): Array<string | number | null> {
  if (!params) return [];
  return params.map((param) => (param === undefined ? null : param));
}

function shredSql(spec: ShredSpec, rows: ReadonlyArray<Record<string, string | number | null>>, binds: ReadonlyArray<string | number | null>) {
  const cmds: Array<[string, Array<string | number | null>]> = [];
  if (spec.deleteWhere.length) {
    const where = spec.deleteWhere.map((column) => `${column.column} = ?`).join(' AND ');
    cmds.push([`DELETE FROM ${spec.table} WHERE ${where};`, spec.deleteWhere.map((column) => binds[column.bindIndex] ?? null)]);
  }
  const placeholders = spec.columns.map(() => '?').join(', ');
  const insert = `${spec.insertVerb} INTO ${spec.table} (${spec.columns.join(', ')}) VALUES (${placeholders});`;
  for (const row of rows) cmds.push([insert, spec.columns.map((column) => row[column] ?? null)]);
  return cmds;
}

export function createSqlJsConnection(options: SqlJsConnectionOptions = {}): SqlJsConnection {
  if (!SqlModule) throw new Error('createSqlJsConnection: call `await initSqlJs()` in beforeAll first');
  const capabilities = options.capabilities ?? 'minimal';
  const db = new SqlModule.Database();

  const calls: SqlJsCallLog = {
    execute: 0,
    executeAsync: 0,
    executeBatch: 0,
    executeBatchAsync: 0,
    shredJsonArrayAsync: 0,
    readerExecute: 0,
    dispose: 0,
  };
  const executed: string[] = [];

  const run = (sql: string, params?: ReadonlyArray<string | number | null>): QueryExecResult => {
    executed.push(sql);
    const stmt = db.prepare(sql);
    try {
      stmt.bind(sanitize(params));
      const out: unknown[] = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      const result: QueryExecResult = {
        rows: { _array: out },
        dispose: () => {
          calls.dispose += 1;
          if (options.poisonOnDispose && result.rows) result.rows._array = undefined;
        },
      };
      return result;
    } finally {
      stmt.free();
    }
  };

  const minimal: SqlJsConnection = {
    execute(sql, params) {
      calls.execute += 1;
      return run(sql, params);
    },
    close() {
      db.close();
    },
    calls,
    executed,
  };
  if (capabilities === 'minimal') return minimal;

  /** A read handle over the same sql.js database, modelling how a read is routed. */
  const reader: PinnedConnection = {
    execute(sql, params) {
      calls.readerExecute += 1;
      return run(sql, params);
    },
    reader: undefined,
  };

  return {
    ...minimal,
    reader,
    executeAsync: async (sql, params) => {
      calls.executeAsync += 1;
      return run(sql, params);
    },
    executeBatch(commands) {
      calls.executeBatch += 1;
      run('BEGIN;');
      try {
        for (const [sql, params] of commands) run(sql, params);
        run('COMMIT;');
      } catch (error) {
        run('ROLLBACK;');
        throw error;
      }
    },
    executeBatchAsync: async (commands) => {
      calls.executeBatchAsync += 1;
      run('BEGIN;');
      try {
        for (const [sql, params] of commands) run(sql, params);
        run('COMMIT;');
      } catch (error) {
        run('ROLLBACK;');
        throw error;
      }
    },
    shredJsonArrayAsync: async (spec, rawJson, binds) => {
      calls.shredJsonArrayAsync += 1;
      const parsed = JSON.parse(rawJson) as unknown;
      const elements = spec.source === 'objectValues' ? Object.values(parsed as Record<string, unknown>) : (parsed as unknown[]);
      const rows = evalShredSpec(spec, elements, binds);
      run('BEGIN;');
      try {
        for (const [sql, params] of shredSql(spec, rows, binds)) run(sql, params);
        run('COMMIT;');
      } catch (error) {
        run('ROLLBACK;');
        throw error;
      }
      return rows.length;
    },
  };
}
