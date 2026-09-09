import { open, openSecondary } from 'react-native-nitro-sqlite';

import { configureDataKernel } from '../index';
import { resetOnceGuards } from '../diagnostics/once_guard';
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
  close: jest.Mock;
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
    close: jest.fn(),
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

/**
 * A secondary handle's name is exclusive for the life of the process, so handles a failed bind opened are not merely
 * untidy: they are what makes the *next* attempt — a retry, or a Fast Refresh re-running the same init — report a
 * handle collision on top of the failure that actually happened.
 */
describe('binding a store — the handles a failure opened', () => {
  const failingBind = (name: string, writer: FakeHandle, reader: FakeHandle) => {
    mockOpen.mockReturnValue(writer as never);
    mockOpenSecondary.mockReturnValue(reader as never);
    bindSqliteBackend('stats', () => {
      openNitroConnection(name, { dedicatedReader: true });
      throw new Error('a schema change forces a rebuild');
    });
  };

  it('closes both of them, handing back the names the next attempt has to open', () => {
    const writer = fakeHandle();
    const reader = fakeHandle();

    failingBind('stats.db', writer, reader);

    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(reader.close).toHaveBeenCalledTimes(1);
  });

  it('forgets the connection, so nothing later reads through a handle that is closed', () => {
    failingBind('stats.db', fakeHandle(), fakeHandle());

    expect(getOpenSqliteConnections().map((entry) => entry.name)).not.toContain('stats.db');
  });

  it('still reports the failure that started it, which is the one worth reading', () => {
    failingBind('stats.db', fakeHandle(), fakeHandle());

    expect(lastReport().scope).toBe('nitro_connection.bind.stats');
    expect(lastReport().context).toContain('stays on its in-memory backend');
  });

  it('leaves a connection another store already had open alone', () => {
    const other = fakeHandle();
    mockOpen.mockReturnValue(other as never);
    openNitroConnection('schedule.db');

    failingBind('stats.db', fakeHandle(), fakeHandle());

    expect(other.close).not.toHaveBeenCalled();
    expect(getOpenSqliteConnections().map((entry) => entry.name)).toContain('schedule.db');
  });

  it('closes the reopened handles of a store that had already bound this database once, which is the Fast Refresh case', () => {
    mockOpen.mockReturnValue(fakeHandle() as never);
    mockOpenSecondary.mockReturnValue(fakeHandle() as never);
    openNitroConnection('again.db', { dedicatedReader: true });

    const writer = fakeHandle();
    const reader = fakeHandle();
    failingBind('again.db', writer, reader);

    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(reader.close).toHaveBeenCalledTimes(1);
    expect(getOpenSqliteConnections().map((entry) => entry.name)).not.toContain('again.db');
  });

  it('closes nothing when the bind succeeds, which is the whole point of holding the handles', () => {
    const writer = fakeHandle();
    mockOpen.mockReturnValue(writer as never);

    bindSqliteBackend('stats', () => {
      openNitroConnection('kept.db');
    });

    expect(writer.close).not.toHaveBeenCalled();
    expect(getOpenSqliteConnections().map((entry) => entry.name)).toContain('kept.db');
  });
});

/**
 * The bind that *succeeds* and then runs again is the ordinary case in development, and it is the one that leaked:
 * the second open registered over the first entry without closing it, so the reader name stayed taken and the store
 * spent the rest of the session reading through the writer handle, contending with its own ingests.
 */
describe('reopening a database this process already holds', () => {
  /** Secondary handle names nitro is currently holding. Claiming one twice is what throws on the device. */
  let taken: Set<string>;
  /** Every handle the fake driver has handed out, newest last, since the point at issue is which ones get closed. */
  let writers: FakeHandle[];
  let readers: FakeHandle[];

  beforeEach(() => {
    taken = new Set();
    writers = [];
    readers = [];
    mockOpen.mockImplementation((() => {
      const handle = fakeHandle();
      writers.push(handle);
      return handle;
    }) as never);
    mockOpenSecondary.mockImplementation((({ handle }: { handle: string }) => {
      if (taken.has(handle)) throw new Error(`NitroSQLite.openSecondary(...): handle '${handle}' is already in use by an open connection`);
      taken.add(handle);
      const opened = fakeHandle();
      opened.close.mockImplementation(() => taken.delete(handle));
      readers.push(opened);
      return opened;
    }) as never);
  });

  const openWithReader = (name: string) => openNitroConnection(name, { dedicatedReader: true });

  it('closes the handles it held, rather than registering over them', () => {
    openWithReader('reopened.db');

    openWithReader('reopened.db');

    expect(writers[0].close).toHaveBeenCalledTimes(1);
    expect(readers[0].close).toHaveBeenCalledTimes(1);
  });

  it('gets its dedicated reader back, instead of degrading to the writer for the rest of the session', () => {
    openWithReader('reopened.db');

    const second = openWithReader('reopened.db');

    expect(second.reader).toBeDefined();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('leaves a database another store has open alone', () => {
    openWithReader('untouched.db');

    openWithReader('reopened.db');

    expect(writers[0].close).not.toHaveBeenCalled();
    expect(readers[0].close).not.toHaveBeenCalled();
    expect(getOpenSqliteConnections().map((entry) => entry.name)).toContain('untouched.db');
  });
});
