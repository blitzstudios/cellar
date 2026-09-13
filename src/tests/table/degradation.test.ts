import { configureDataKernel, INERT_ERRORS } from '../../runtime';
import { RowTableSchema } from '../../table/types';
import { createSqliteRowTable } from '../../table/sqlite';
import { defineSqliteStore } from '../../define_sqlite_store';
import { itDev, itProd } from '../../testing/dev_mode';
import { resetOnceGuards } from '../../diagnostics/once_guard';
import { guardedConnection, readRows, runBatch, SqliteConnection } from '../../table/connection';

type Thing = { id: string; region: string };

const schema: RowTableSchema<Thing> = {
  table: 'things',
  columns: { id: { type: 'TEXT' }, region: { type: 'TEXT' } },
  primaryKey: ['id'],
};

function brokenConn(match = /./): SqliteConnection & { attempts: number } {
  const conn = {
    attempts: 0,
    execute: (sql: string) => {
      conn.attempts += 1;
      if (match.test(sql)) throw new Error('SQLITE_IOERR: disk I/O error');
      return { rows: { _array: [] } };
    },
  };
  return conn as SqliteConnection & { attempts: number };
}

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

beforeEach(() => {
  resetOnceGuards();
});

describe('guardedConnection', () => {
  itProd('answers a failed read the way an empty store would, rather than throwing into render', () => {
    const conn = guardedConnection(brokenConn(), () => {});
    expect(readRows(conn, 'SELECT * FROM things;')).toEqual([]);
  });

  itProd('reports the failure once and stops touching the driver, since the next statement fails the same way', () => {
    const broken = brokenConn();
    const onFatal = jest.fn();
    const conn = guardedConnection(broken, onFatal);

    for (let index = 0; index < 5; index += 1) readRows(conn, 'SELECT * FROM things;');

    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(broken.attempts).toBe(1);
  });

  itProd('names the operation that failed, so a read and an ingest are told apart in the report', () => {
    const onFatal = jest.fn();
    const conn = guardedConnection(brokenConn(), onFatal);
    conn.execute('SELECT 1;');
    expect(onFatal.mock.calls[0][1]).toBe('execute');
  });

  itProd('swallows a failed write too, rather than leaving an ingest to throw out of a socket handler', () => {
    const conn = guardedConnection(brokenConn(), () => {});
    expect(() => runBatch(conn, [['INSERT INTO things (id) VALUES (?);', ['a']]])).not.toThrow();
  });

  itProd('lets a failed native shred reject, because that rejection is what `shred` falls back to a JS parse on', async () => {
    const onFatal = jest.fn();
    const broken: SqliteConnection = {
      execute: () => ({ rows: { _array: [] } }),
      shredJsonArrayAsync: () => Promise.reject(new Error('a payload shape the native shredder cannot take')),
    };
    const conn = guardedConnection(broken, onFatal);

    await expect(conn.shredJsonArrayAsync!({} as never, '[]', [])).rejects.toThrow(/cannot take/);
    // A shred that could not parse says nothing about the disk, so the store keeps its SQLite backend.
    expect(onFatal).not.toHaveBeenCalled();
  });

  itProd('stops shredding once some other statement has already degraded the store', async () => {
    const broken: SqliteConnection = {
      execute: () => {
        throw new Error('SQLITE_IOERR: disk I/O error');
      },
      shredJsonArrayAsync: jest.fn(async () => 5),
    };
    const conn = guardedConnection(broken, () => {});
    conn.execute('SELECT 1;');

    await expect(conn.shredJsonArrayAsync!({} as never, '[]', [])).resolves.toBe(0);
    expect(broken.shredJsonArrayAsync).not.toHaveBeenCalled();
  });

  itProd('guards the read handle as well, which is where every read actually goes', () => {
    const onFatal = jest.fn();
    const conn = guardedConnection({ execute: () => ({ rows: { _array: [] } }), reader: { ...brokenConn(), reader: undefined } }, onFatal);

    expect(readRows(conn, 'SELECT * FROM things;')).toEqual([]);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0][1]).toBe('reader.execute');
  });

  itProd('leaves a working driver alone, including the optional methods it does not have', () => {
    const plain: SqliteConnection = { execute: () => ({ rows: { _array: [{ id: 'a' }] } }) };
    const conn = guardedConnection(plain, () => {});

    expect(readRows(conn, 'SELECT * FROM things;')).toEqual([{ id: 'a' }]);
    // Callers branch on whether the driver has these, so the wrapper mirrors the driver's own set exactly.
    expect(conn.executeBatch).toBeUndefined();
    expect(conn.shredJsonArrayAsync).toBeUndefined();
    expect(conn.reader).toBeUndefined();
  });

  itDev('rethrows in development, so a broken statement is not mistaken for a broken disk', () => {
    const conn = guardedConnection(brokenConn(), () => {});
    expect(() => conn.execute('SELECT 1;')).toThrow(/SQLITE_IOERR/);
  });
});

describe('kernel degradation', () => {
  const buildBackend = (table: { find: (where: Partial<Thing>) => Thing[] }) => ({
    reads: { all: () => table.find({}) },
    lifecycle: { forget: jest.fn() },
  });

  itProd('hands the store back to its in-memory backend, and tells every reader to look again', async () => {
    const bumped = jest.fn();
    const kernel = defineSqliteStore<Thing, { reads: { tag: string } }>({
      name: 'testy',
      schema,
      buildBackend: () => ({ reads: { tag: 'memory' } }),
    });
    kernel.setBackend({ reads: { tag: 'sqlite' } });
    kernel.version.subscribe(['us'], bumped);
    kernel.version.bump(['us']);
    bumped.mockClear();

    kernel.degrade({ context: 'disk went away' });

    // The swap is deferred to a microtask, so it lands after the render that read.
    expect(kernel.getBackend().reads.tag).toBe('sqlite');

    await flushMicrotasks();

    expect(kernel.getBackend().reads.tag).toBe('memory');
    expect(bumped).toHaveBeenCalled();
  });

  itProd('runs the registered resets before the swap, so nothing is left describing the old backend', async () => {
    const order: string[] = [];
    const kernel = defineSqliteStore<Thing, { reads: object }>({
      name: 'testy',
      schema,
      buildBackend: () => {
        order.push('rebuilt');
        return { reads: {} };
      },
    });
    kernel.onDegrade(() => order.push('forgot'));

    kernel.degrade({ context: 'x' });
    await flushMicrotasks();

    expect(order).toEqual(['forgot', 'rebuilt']);
  });

  itProd('degrades once, because a full disk is a condition rather than an event', async () => {
    const reset = jest.fn();
    const kernel = defineSqliteStore<Thing, { reads: object }>({ name: 'testy', schema, buildBackend: () => ({ reads: {} }) });
    kernel.onDegrade(reset);

    kernel.degrade({ context: 'a' });
    kernel.degrade({ context: 'b' });
    await flushMicrotasks();

    expect(reset).toHaveBeenCalledTimes(1);
  });

  itProd('reports it, since a store that silently halved its own performance is the failure you never hear about', () => {
    const captureException = jest.fn();
    configureDataKernel({ errors: { captureException, captureMessage: jest.fn() } });
    const kernel = defineSqliteStore<Thing, { reads: object }>({ name: 'testy', schema, buildBackend: () => ({ reads: {} }) });

    kernel.degrade({ context: 'disk went away', error: new Error('SQLITE_IOERR') });

    expect(captureException.mock.calls[0][1].tags).toEqual({ off_heap_degradation: 'testy.runtime' });
    configureDataKernel({ errors: INERT_ERRORS });
  });
});

describe('defineSqliteStore — the wiring', () => {
  itProd('degrades the whole store when one of its statements fails, and refills from the memory backend', async () => {
    const forget = jest.fn();
    const store = defineSqliteStore({
      name: 'things',
      schema,
      buildBackend: (rowTable) => ({ reads: { all: () => rowTable.find({}) }, lifecycle: { forget } }),
    });
    store.setBackend(store.createSqliteBackend(brokenConn(/SELECT/)));

    expect(store.getBackend().reads.all()).toEqual([]);
    await flushMicrotasks();

    expect(forget).toHaveBeenCalledTimes(1);
    expect(store.getBackend().reads.all()).toEqual([]);
  });

  itProd('gives the capabilities the guarded handle too, so a failing accelerator degrades rather than throws', () => {
    let capsConn: SqliteConnection | undefined;
    const store = defineSqliteStore<Thing, { reads: object }, { probe: SqliteConnection }>({
      name: 'things',
      schema,
      buildBackend: () => ({ reads: {} }),
      sqliteCapabilities: (conn) => {
        capsConn = conn;
        return { probe: conn };
      },
    });
    const broken = brokenConn(/SELECT/);
    store.createSqliteBackend(broken);

    expect(() => readRows(capsConn!, 'SELECT 1;')).not.toThrow();
  });
});

describe('a native shred the driver refuses', () => {
  itProd('falls back to the JS parse over the guarded connection, which is the only wiring production runs', async () => {
    const calls: string[] = [];
    const conn: SqliteConnection = {
      execute: (sql) => {
        calls.push(sql);
        return { rows: { _array: [] } };
      },
      shredJsonArrayAsync: () => Promise.reject(new Error('a payload shape the native shredder cannot take')),
    };
    const onFatal = jest.fn();
    const table = createSqliteRowTable(schema, guardedConnection(conn, onFatal), {
      specs: { all: {} as never },
      variant: () => 'all',
      binds: (scope) => [String(scope.region)],
    });
    const parseRows = jest.fn(() => [{ id: 'a', region: 'us' }]);

    const count = await table.shred({ region: 'us' }, '[{"id":"a"}]', parseRows);

    expect(parseRows).toHaveBeenCalled();
    expect(count).toBe(1);
    expect(calls.some((sql) => /INSERT/.test(sql) && sql.includes('things'))).toBe(true);
    // The rows landed, so the store keeps the SQLite backend it would otherwise have thrown away for the session.
    expect(onFatal).not.toHaveBeenCalled();
  });
});

describe('a degraded store still answers', () => {
  itProd('reads empty rather than throwing, all the way through the row store', () => {
    const rowTable = createSqliteRowTable(
      schema,
      guardedConnection(brokenConn(/SELECT/), () => {}),
    );
    rowTable.init();

    expect(rowTable.find({ region: 'us' })).toEqual([]);
    expect(rowTable.getOne({ id: 'a' })).toBeUndefined();
    expect(rowTable.has({ region: 'us' })).toBe(false);
  });
});
