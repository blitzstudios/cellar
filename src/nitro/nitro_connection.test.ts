import { open, openSecondary } from 'react-native-nitro-sqlite';

import { configureDataKernel, resetOnceGuards } from '../index';
import { bindSqliteBackend, bindSqliteStore, getOpenSqliteConnections, openNitroConnection } from './nitro_connection';

jest.mock('react-native-nitro-sqlite', () => ({ open: jest.fn(), openSecondary: jest.fn() }));

const mockOpen = open as jest.MockedFunction<typeof open>;
const mockOpenSecondary = openSecondary as jest.MockedFunction<typeof openSecondary>;
const captureException = jest.fn();
configureDataKernel({ errors: { captureException, captureMessage: jest.fn() } });

/** What the adapter reported: the scope it filed under, and the context line it filed. */
function lastReport(): { scope: string; context: string } {
  const [, captureContext] = captureException.mock.calls[captureException.mock.calls.length - 1];
  return { scope: String(captureContext.tags.off_heap_degradation), context: String(captureContext.extra.context) };
}

interface FakeHandle {
  executed: Array<{ sql: string; params?: unknown[] }>;
  batches: unknown[][];
  execute: jest.Mock;
  executeAsync: jest.Mock;
  executeBatch: jest.Mock;
  executeBatchAsync: jest.Mock;
}

function fakeHandle(opts: { failOn?: string; asyncResult?: unknown } = {}): FakeHandle {
  const executed: Array<{ sql: string; params?: unknown[] }> = [];
  const batches: unknown[][] = [];
  const record = (sql: string, params?: unknown[]) => {
    executed.push({ sql, params });
    if (opts.failOn && sql.includes(opts.failOn)) throw new Error(`cannot apply ${sql}`);
    return { rows: { _array: [] } };
  };
  return {
    executed,
    batches,
    execute: jest.fn(record),
    executeAsync: jest.fn((sql: string, params?: unknown[]) => {
      record(sql, params);
      return Promise.resolve(opts.asyncResult ?? { rows: { _array: [] } });
    }),
    executeBatch: jest.fn((cmds: unknown[]) => {
      batches.push(cmds);
    }),
    executeBatchAsync: jest.fn((cmds: unknown[]) => {
      batches.push(cmds);
      return Promise.resolve();
    }),
  };
}

const sqlOf = (handle: FakeHandle) => handle.executed.map((command) => command.sql);

let warn: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  // Each report is filed once per scope per session, and these tests reuse scopes.
  resetOnceGuards();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => warn.mockRestore());

describe('openNitroConnection — pragmas', () => {
  it('applies the settings the store depends on', () => {
    const handle = fakeHandle();
    mockOpen.mockReturnValue(handle as never);

    openNitroConnection('things');

    expect(sqlOf(handle)).toEqual([
      'PRAGMA journal_mode=WAL;',
      'PRAGMA synchronous=NORMAL;',
      'PRAGMA busy_timeout=5000;',
      'PRAGMA temp_store=MEMORY;',
      'PRAGMA cache_size=-8000;',
    ]);
  });

  it('keeps applying the rest after one fails, so a failed journal_mode cannot swallow busy_timeout', () => {
    const handle = fakeHandle({ failOn: 'journal_mode' });
    mockOpen.mockReturnValue(handle as never);

    openNitroConnection('things');

    expect(sqlOf(handle)).toContain('PRAGMA busy_timeout=5000;');
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('names the setting that failed and what its absence costs, since neither is recoverable from the error', () => {
    mockOpen.mockReturnValue(fakeHandle({ failOn: 'busy_timeout' }) as never);

    openNitroConnection('things');

    const report = lastReport();
    expect(report.scope).toBe('nitro_connection.pragma.things');
    expect(report.context).toContain('PRAGMA busy_timeout=5000;');
    expect(report.context).toContain('SQLITE_BUSY');
  });
});

describe('openNitroConnection — the dedicated read handle', () => {
  it('opens no second handle unless asked, and reads then share the writer', () => {
    mockOpen.mockReturnValue(fakeHandle() as never);

    const conn = openNitroConnection('things');

    expect(mockOpenSecondary).not.toHaveBeenCalled();
    expect(conn.reader).toBeUndefined();
  });

  it('opens the reader against the same database under its own handle name, with the same pragmas', () => {
    const writer = fakeHandle();
    const reader = fakeHandle();
    mockOpen.mockReturnValue(writer as never);
    mockOpenSecondary.mockReturnValue(reader as never);

    const conn = openNitroConnection('things', { dedicatedReader: true });

    expect(mockOpenSecondary).toHaveBeenCalledWith({ name: 'things', handle: 'things:reader' });
    expect(sqlOf(reader)).toEqual(sqlOf(writer));
    expect(conn.reader).toBeDefined();
  });

  it('is a pinned handle, so nothing can route off it a second time', () => {
    mockOpen.mockReturnValue(fakeHandle() as never);
    mockOpenSecondary.mockReturnValue(fakeHandle() as never);

    const conn = openNitroConnection('things', { dedicatedReader: true });

    expect(conn.reader?.reader).toBeUndefined();
  });

  it('degrades to sharing the writer when the second handle will not open, rather than failing the store', () => {
    mockOpen.mockReturnValue(fakeHandle() as never);
    mockOpenSecondary.mockImplementation(() => {
      throw new Error('too many handles');
    });

    const conn = openNitroConnection('things', { dedicatedReader: true });

    expect(conn.reader).toBeUndefined();
    expect(conn.execute).toBeDefined();
    expect(lastReport().context).toContain('contend');
  });
});

describe('openNitroConnection — parameter coercion', () => {
  const paramsOf = (handle: FakeHandle) => handle.executed[handle.executed.length - 1].params;

  it('narrows the JS values a caller can hold to the three the bridge takes', () => {
    const handle = fakeHandle();
    mockOpen.mockReturnValue(handle as never);
    const conn = openNitroConnection('things');

    conn.execute('SELECT ?, ?, ?, ?, ?;', [true, false, null, 'a', 2] as never);

    // SQLite has no boolean type; an uncoerced one binds as `null`.
    expect(paramsOf(handle)).toEqual([1, 0, null, 'a', 2]);
  });

  it('passes no params at all through as undefined, rather than as an empty bind list', () => {
    const handle = fakeHandle();
    mockOpen.mockReturnValue(handle as never);

    openNitroConnection('things').execute('SELECT 1;');

    expect(paramsOf(handle)).toBeUndefined();
  });

  it('coerces batch params too, which are the ones an ingest binds by the thousand', () => {
    const handle = fakeHandle();
    mockOpen.mockReturnValue(handle as never);
    const conn = openNitroConnection('things');

    conn.executeBatch?.([['INSERT INTO t VALUES (?, ?);', [true, null] as never]]);

    expect(handle.batches[0]).toEqual([{ query: 'INSERT INTO t VALUES (?, ?);', params: [1, null] }]);
  });
});

describe('openNitroConnection — shredJsonArrayAsync', () => {
  const spec = {
    version: 1 as const,
    table: 'things',
    insertVerb: 'INSERT OR REPLACE' as const,
    columns: ['id'],
    ops: [{ op: 'text' as const, path: 'id' }],
    deleteWhere: [{ column: 'scope', bindIndex: 0 }],
  };

  it('dispatches through the sentinel the C++ fork matches, with the spec, the payload, then the binds', async () => {
    const handle = fakeHandle({ asyncResult: { rowsAffected: 7 } });
    mockOpen.mockReturnValue(handle as never);

    const count = await openNitroConnection('things').shredJsonArrayAsync!(spec, '[{"id":"a"}]', ['s']);

    const call = handle.executeAsync.mock.calls[0];
    expect(call[0]).toBe('-- nitro_shred_v1');
    expect(call[1]).toEqual([JSON.stringify(spec), '[{"id":"a"}]', 's']);
    expect(count).toBe(7);
  });

  it('counts zero when the driver reports no row count, rather than assuming the shred landed', async () => {
    mockOpen.mockReturnValue(fakeHandle({ asyncResult: {} }) as never);
    await expect(openNitroConnection('things').shredJsonArrayAsync!(spec, '[]', [])).resolves.toBe(0);

    mockOpen.mockReturnValue(fakeHandle({ asyncResult: undefined }) as never);
    await expect(openNitroConnection('things').shredJsonArrayAsync!(spec, '[]', [])).resolves.toBe(0);
  });
});

describe('binding a store', () => {
  it('leaves the store on its in-memory backend when the SQLite one throws, instead of taking the app down', () => {
    const boom = () => {
      throw new Error('no such file or directory');
    };

    expect(() => bindSqliteBackend('player_stats', boom)).not.toThrow();
    expect(lastReport().context).toContain('stays on its in-memory backend');
  });

  it('wires the opened connection into the backend factory and hands the result to the setter', () => {
    mockOpen.mockReturnValue(fakeHandle() as never);
    mockOpenSecondary.mockReturnValue(fakeHandle() as never);
    const setBackend = jest.fn();
    const createBackend = jest.fn(() => 'backend');

    bindSqliteStore('player_stats', 'stats.db', setBackend, createBackend, { dedicatedReader: true });

    expect(mockOpen).toHaveBeenCalledWith({ name: 'stats.db' });
    expect(mockOpenSecondary).toHaveBeenCalled();
    expect(createBackend).toHaveBeenCalledWith(expect.objectContaining({ execute: expect.any(Function) }));
    expect(setBackend).toHaveBeenCalledWith('backend');
  });

  it('registers the connection under its database name, which is what the dev overlay dumps', () => {
    mockOpen.mockReturnValue(fakeHandle() as never);

    const conn = openNitroConnection('registered.db');

    expect(getOpenSqliteConnections()).toContainEqual({ name: 'registered.db', conn });
  });
});
