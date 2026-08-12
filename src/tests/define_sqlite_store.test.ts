import { defineSqliteStore, StoreBackendShape } from '../define_sqlite_store';
import { resetOnceGuards } from '../diagnostics/once_guard';
import { itDev } from '../testing/dev_mode';
import { RowTableSchema } from '../table/types';

type Thing = { id: string };

const schema: RowTableSchema<Thing> = {
  table: 'things',
  columns: { id: { type: 'TEXT' } },
  primaryKey: ['id'],
};

/** `build` stands in for the in-memory backend, so a test can watch when — and whether — it is constructed. */
const storeOf = <B extends StoreBackendShape>(name: string, build: () => B) => defineSqliteStore<Thing, B>({ name, schema, buildBackend: build });

describe('defineSqliteStore — the backend slot', () => {
  beforeEach(() => {
    resetOnceGuards();
  });

  it('exposes a version atom and swaps the active backend', () => {
    const store = storeOf('test_store', () => ({ reads: { label: 'memory' } }));

    expect(store.getBackend().reads.label).toBe('memory');
    expect(store.version.key(['a', 'b'])).toEqual(['test_store_version', 'a\u0000b']);

    store.setBackend({ reads: { label: 'sqlite' } });
    expect(store.getBackend().reads.label).toBe('sqlite');
  });

  it('never builds the in-memory backend when one is bound before the first read', () => {
    let builds = 0;
    const store = storeOf('test_store', () => {
      builds += 1;
      return { reads: { label: 'memory' } };
    });

    store.setBackend({ reads: { label: 'sqlite' } });

    expect(store.getBackend().reads.label).toBe('sqlite');
    expect(builds).toBe(0);
  });

  it('builds the in-memory backend once, however many reads it serves', () => {
    let builds = 0;
    const store = storeOf('test_store', () => {
      builds += 1;
      return { reads: {} };
    });

    expect(store.getBackend()).toBe(store.getBackend());
    expect(builds).toBe(1);
  });

  itDev('warns when a backend is bound after something has already read', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = storeOf('test_store', () => ({ reads: {} }));

    store.getBackend();
    store.setBackend({ reads: {} });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('store_backend_slot.late_bind');
    warn.mockRestore();
  });

  it('stays silent for the ordinary order, which is bind and then read', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = storeOf('test_store', () => ({ reads: {} }));

    store.setBackend({ reads: {} });
    store.getBackend();

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
