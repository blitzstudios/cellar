import { defineSqliteStore } from '../define_sqlite_store';
import { resetOnceGuards } from '../diagnostics/once_guard';
import { itDev } from '../testing/dev_mode';
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
