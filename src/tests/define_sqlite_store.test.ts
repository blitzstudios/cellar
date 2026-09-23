import { defineSqliteStore } from '../define_sqlite_store';
import { resetOnceGuards } from '../diagnostics/once_guard';
import { itDev, itProd } from '../testing/dev_mode';
import { SqliteConnection } from '../table/connection';
import { RowTableSchema } from '../table/types';

type Thing = { id: string };

const schema: RowTableSchema<Thing> = {
  table: 'things',
  columns: { id: { type: 'TEXT' } },
  primaryKey: ['id'],
  unit: 'id',
};

/** A connection every statement succeeds on, which is all binding needs. */
const okConn = (): SqliteConnection => ({ execute: () => ({ rows: { _array: [] } }) }) as unknown as SqliteConnection;

/**
 * A store whose surface says which table it was built on, and counts its builds, so a test can watch when — and
 * whether — each is constructed. SQLite is told apart by the capability only it is handed.
 */
function labelledStore() {
  const builds = { memory: 0, sqlite: 0 };
  const store = defineSqliteStore<Thing, { reads: { label: string; describe: () => string }; lifecycle: { forget: jest.Mock } }, { sqlite: true }>({
    name: 'test_store',
    schema,
    build: (_table, _version, caps) => {
      const label = caps.sqlite ? 'sqlite' : 'memory';
      builds[label] += 1;
      return { reads: { label, describe: () => label }, lifecycle: { forget: jest.fn() } };
    },
    sqliteCapabilities: () => ({ sqlite: true }),
  });
  return { store, builds };
}

describe('defineSqliteStore — the running table', () => {
  beforeEach(() => {
    resetOnceGuards();
  });

  it('starts on an in-memory table and moves onto SQLite when bound', () => {
    const { store } = labelledStore();

    expect(store.reads.label).toBe('memory');
    store.bindSqlite(okConn());
    expect(store.reads.label).toBe('sqlite');
  });

  it('never builds the in-memory surface when SQLite is bound before the first read', () => {
    const { store, builds } = labelledStore();

    store.bindSqlite(okConn());

    expect(store.reads.label).toBe('sqlite');
    expect(builds).toEqual({ memory: 0, sqlite: 1 });
  });

  it('builds the in-memory surface once, however many reads it serves', () => {
    const { store, builds } = labelledStore();

    expect(store.reads.label).toBe(store.reads.label);
    expect(builds.memory).toBe(1);
  });

  it('resolves a group at each access, so a caller holding it follows the store onto SQLite', () => {
    const { store } = labelledStore();
    const { reads } = store;

    expect(reads.describe()).toBe('memory');
    store.bindSqlite(okConn());
    expect(reads.describe()).toBe('sqlite');
  });

  it('lists the running surface, so a group can be enumerated like the object it stands for', () => {
    const { store } = labelledStore();

    expect(Object.keys(store.reads).sort()).toEqual(['describe', 'label']);
    expect('label' in store.reads).toBe(true);
  });

  itDev('warns when SQLite is bound after something has already read', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = labelledStore();

    void store.reads.label;
    store.bindSqlite(okConn());

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('store.late_bind');
    warn.mockRestore();
  });

  it('stays silent for the ordinary order, which is bind and then read', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = labelledStore();

    store.bindSqlite(okConn());
    void store.reads.label;

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('defineSqliteStore — testing', () => {
  it('builds a surface over a table of the test’s own, without moving the store', () => {
    const { store } = labelledStore();

    expect(store.testing.over(undefined, { caps: { sqlite: true } }).reads.label).toBe('sqlite');
    expect(store.reads.label).toBe('memory');
  });

  it('swaps a surface in behind the store, and reset puts a fresh in-memory one back', () => {
    const { store, builds } = labelledStore();
    store.testing.swap({ reads: { label: 'seeded', describe: () => 'seeded' }, lifecycle: { forget: jest.fn() } });

    expect(store.reads.label).toBe('seeded');
    store.testing.reset();
    expect(store.reads.label).toBe('memory');
    expect(builds.memory).toBe(1);
  });

  itDev('does not report a swap as a late bind, since it is a test seeding the store rather than startup', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = labelledStore();

    void store.reads.label;
    store.testing.swap({ reads: { label: 'seeded', describe: () => 'seeded' }, lifecycle: { forget: jest.fn() } });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * A failure mid-session. In a development build the failing statement throws instead, so these run in the production
 * pass only.
 */
describe('defineSqliteStore — a SQLite failure mid-session', () => {
  type ReadSurface = { reads: { label: string; rows: () => Thing[] }; lifecycle: { forget: jest.Mock } };

  /** A connection whose `SELECT`s fail with `message` once `failing.now` is set, logging every statement it runs. */
  const failableConn = (message: string) => {
    const failing = { now: false };
    const ran: string[] = [];
    const conn = {
      execute: (sql: string) => {
        ran.push(sql);
        if (failing.now && sql.startsWith('SELECT')) throw new Error(message);
        return { rows: { _array: [] } };
      },
    } as unknown as SqliteConnection;
    return { conn, failing, ran };
  };

  function readingStore() {
    const forgets: jest.Mock[] = [];
    const store = defineSqliteStore<Thing, ReadSurface, { sqlite: true }>({
      name: 'reading_store',
      schema: { ...schema, meta: { table: 'things_meta', keyColumns: ['id'], column: 'etag' } },
      build: (table, _version, caps) => {
        const forget = jest.fn();
        forgets.push(forget);
        return { reads: { label: caps.sqlite ? 'sqlite' : 'memory', rows: () => table.find({}) }, lifecycle: { forget } };
      },
      sqliteCapabilities: () => ({ sqlite: true }),
    });
    return { store, forgets };
  }

  const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

  beforeEach(() => {
    resetOnceGuards();
  });

  itProd('reopens the database, clears its ETags, and runs on the reopened connection', async () => {
    const { store, forgets } = readingStore();
    const first = failableConn('disk I/O error');
    const second = failableConn('');
    const reopen = jest.fn(() => second.conn);
    store.bindSqlite(first.conn, { reopen });

    first.failing.now = true;
    expect(store.reads.rows()).toEqual([]);
    await flush();

    expect(reopen).toHaveBeenCalledWith({ discard: false });
    expect(second.ran).toContain('DELETE FROM things_meta;');
    expect(store.reads.label).toBe('sqlite');
    expect(forgets[0]).toHaveBeenCalledTimes(1);
    second.ran.length = 0;
    store.reads.rows();
    expect(second.ran.some((sql) => sql.startsWith('SELECT'))).toBe(true);
  });

  itProd('deletes a corrupt database before reopening it, and keeps nothing it vouched for', async () => {
    const { store } = readingStore();
    const first = failableConn('database disk image is malformed (code 11 SQLITE_CORRUPT)');
    const second = failableConn('');
    const reopen = jest.fn(() => second.conn);
    store.bindSqlite(first.conn, { reopen });

    first.failing.now = true;
    store.reads.rows();
    await flush();

    expect(reopen).toHaveBeenCalledWith({ discard: true });
    expect(second.ran).not.toContain('DELETE FROM things_meta;');
    expect(store.reads.label).toBe('sqlite');
  });

  itProd('falls back onto an in-memory table once reopening has failed twice, and says so to the binding', async () => {
    const { store } = readingStore();
    const conns = [failableConn('disk I/O error'), failableConn('disk I/O error'), failableConn('disk I/O error')];
    let opened = 0;
    const reopen = jest.fn(() => conns[(opened += 1)].conn);
    const onFallback = jest.fn();
    store.bindSqlite(conns[0].conn, { reopen, onFallback });

    for (const conn of conns) {
      conn.failing.now = true;
      store.reads.rows();
      // eslint-disable-next-line no-await-in-loop
      await flush();
      // eslint-disable-next-line no-await-in-loop
      await flush();
    }

    expect(reopen).toHaveBeenCalledTimes(2);
    expect(store.reads.label).toBe('memory');
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  itProd('falls back straight away when the bind gave no way to reopen', async () => {
    const { store } = readingStore();
    const only = failableConn('disk I/O error');
    store.bindSqlite(only.conn);

    only.failing.now = true;
    store.reads.rows();
    await flush();
    await flush();

    expect(store.reads.label).toBe('memory');
  });

  itProd('falls back when the reopen itself throws', async () => {
    const { store } = readingStore();
    const first = failableConn('disk I/O error');
    const onFallback = jest.fn();
    store.bindSqlite(first.conn, {
      reopen: () => {
        throw new Error('unable to open database file');
      },
      onFallback,
    });

    first.failing.now = true;
    store.reads.rows();
    await flush();
    await flush();

    expect(store.reads.label).toBe('memory');
    expect(onFallback).toHaveBeenCalledTimes(1);
  });
});

describe('defineSqliteStore — moving a running store onto SQLite', () => {
  it('forgets what the in-memory table fetched, and reads from SQLite from then on', () => {
    const { store } = labelledStore();
    const memoryForget = (store.lifecycle as { forget: jest.Mock }).forget;
    expect(store.reads.label).toBe('memory');

    store.moveToSqlite(okConn());

    expect(memoryForget).toHaveBeenCalledTimes(1);
    expect(store.reads.label).toBe('sqlite');
  });

  it('leaves the store where it was when it cannot be built over the connection', () => {
    const store = defineSqliteStore<Thing, { reads: { label: string } }, { sqlite: true }>({
      name: 'unbuildable',
      schema,
      build: (_table, _version, caps) => {
        if (caps.sqlite) throw new Error('migration failed');
        return { reads: { label: 'memory' } };
      },
      sqliteCapabilities: () => ({ sqlite: true }),
    });
    expect(store.reads.label).toBe('memory');

    expect(() => store.moveToSqlite(okConn())).toThrow('migration failed');
    expect(store.reads.label).toBe('memory');
  });
});
