import {
  VersionedSourceCache,
  byVersion,
  bySource,
  createBoundedLru,
  createVersionedCache,
  createVersionedSourceCache,
  declareMemos,
  shallowEqualArray,
  shallowEqualRecord,
  shallowEqualStruct,
} from '../caches';
import { itDev } from '../testing/dev_mode';
import { makeResult } from '../store_result';
import { BatchCommand, readRows, runBatch, runBatchAsync, SqliteConnection } from '../table/connection';
import { resetOnceGuards } from '../diagnostics/once_guard';

const memoName = (name: string) => ({ name, keyedBy: 'a test key' });

describe('store_result', () => {
  it('derives the DataResult envelope from status, defaulting refetch/isFetching', () => {
    const refetch = expect.any(Function);
    expect(makeResult('x', 'loading')).toEqual({ data: 'x', status: 'loading', isLoading: true, isFetching: true, isSuccess: false, isError: false, refetch });
    expect(makeResult(1, 'success')).toEqual({ data: 1, status: 'success', isLoading: false, isFetching: false, isSuccess: true, isError: false, refetch });
    expect(makeResult(null, 'error')).toEqual({ data: null, status: 'error', isLoading: false, isFetching: false, isSuccess: false, isError: true, refetch });
  });

  it('threads isFetching / refetch through when provided', () => {
    const refetch = jest.fn();
    const result = makeResult('x', 'success', { isFetching: true, refetch });
    expect(result.isFetching).toBe(true);
    result.refetch();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('create_versioned_store', () => {
  it('caches per key until the partition version changes, then recomputes', () => {
    const cache = createVersionedCache<number>(16);
    const versions = new Map<string, number>();
    const ver = (partition: string) => versions.get(partition) ?? 0;
    let calls = 0;
    const compute = () => {
      calls += 1;
      return calls;
    };

    expect(cache.read('a', ver('nfl'), compute)).toBe(1);
    expect(cache.read('a', ver('nfl'), compute)).toBe(1);
    expect(calls).toBe(1);

    expect(cache.read('b', ver('nba'), compute)).toBe(2);
    expect(calls).toBe(2);

    versions.set('nfl', 1);
    expect(cache.read('a', ver('nfl'), compute)).toBe(3);
    expect(calls).toBe(3);
    expect(cache.read('b', ver('nba'), compute)).toBe(2);
    expect(calls).toBe(3);
  });

  it('read treats a cached undefined as a hit, which is what a nullable point read needs', () => {
    const cache = createVersionedCache<string | undefined>(16);
    const compute = jest.fn(() => undefined);

    expect(cache.read('a', 1, compute)).toBeUndefined();
    expect(cache.read('a', 1, compute)).toBeUndefined();

    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('read applies isEqual, so an equal recompute at a new version keeps the prior reference', () => {
    const cache = createVersionedCache<{ n: number }>(16, (left, right) => left.n === right.n);

    const first = cache.read('a', 1, () => ({ n: 1 }));
    const second = cache.read('a', 2, () => ({ n: 1 }));

    expect(second).toBe(first);
  });
});

describe('createVersionedCache', () => {
  it('returns a fresh hit only at the matching version (stale entry reads as a miss)', () => {
    const cache = createVersionedCache<number>(16);
    cache.set('a', 0, 1);
    expect(cache.peek('a', 0)).toEqual({ version: 0, value: 1 });
    expect(cache.peek('a', 1)).toBeUndefined();
    expect(cache.peek('b', 0)).toBeUndefined();
  });

  it('distinguishes a cached undefined payload from a miss, without the caller wrapping it', () => {
    const cache = createVersionedCache<number | undefined>(16);
    cache.set('absent', 0, undefined);
    const hit = cache.peek('absent', 0);
    expect(hit).toBeDefined();
    expect(hit?.value).toBeUndefined();
    expect(cache.peek('never', 0)).toBeUndefined();
  });

  it('with isEqual, keeps the prior reference across a version bump when content is unchanged', () => {
    const isEqual = (left: { n: number }, right: { n: number }) => left.n === right.n;
    const cache = createVersionedCache<{ n: number }>(16, isEqual);
    const v0 = { n: 5 };
    expect(cache.set('a', 0, v0)).toBe(v0);

    const recomputed = { n: 5 };
    const stored = cache.set('a', 1, recomputed);
    expect(stored).toBe(v0);
    expect(cache.peek('a', 1)?.value).toBe(v0);

    const changed = { n: 6 };
    expect(cache.set('a', 2, changed)).toBe(changed);
    expect(cache.peek('a', 2)?.value).toBe(changed);
  });

  it('without isEqual, always stores the new reference', () => {
    const cache = createVersionedCache<{ n: number }>(16);
    const v0 = { n: 5 };
    const v1 = { n: 5 };
    cache.set('a', 0, v0);
    expect(cache.set('a', 1, v1)).toBe(v1);
  });

  it('evicts the least-recently-used entry past maxEntries', () => {
    const cache = createVersionedCache<number>(2);
    cache.set('a', 0, 1);
    cache.set('b', 0, 2);
    cache.peek('a', 0); // touch 'a' so 'b' is now the LRU
    cache.set('c', 0, 3);
    expect(cache.peek('a', 0)?.value).toBe(1);
    expect(cache.peek('c', 0)?.value).toBe(3);
    expect(cache.peek('b', 0)).toBeUndefined();
  });
});

describe('createBoundedLru', () => {
  it('counts reading an entry that holds `undefined` as a use, rather than leaving it pinned at the cold end', () => {
    const lru = createBoundedLru<number | undefined>(2);
    lru.set('absent', undefined);
    lru.set('b', 2);

    lru.get('absent');
    lru.set('c', 3);

    expect([...lru.keys()]).toEqual(['absent', 'c']);
  });
});

describe('createVersionedSourceCache', () => {
  it('answers from the version alone, so a repeat read at one version needs no rows to compare against', () => {
    const cache = createVersionedSourceCache<{ n: number }>(16, memoName('test.both'));
    const built = cache.put('row', 1, 'a', () => ({ n: 1 }));

    expect(cache.peek('row', 1)?.value).toBe(built);
  });

  it('reports a miss once the version moves, which is what sends the caller back to the table', () => {
    const cache = createVersionedSourceCache<{ n: number }>(16, memoName('test.both'));
    cache.put('row', 1, 'a', () => ({ n: 1 }));

    expect(cache.peek('row', 2)).toBeUndefined();
  });

  it('keeps the reference across a bump whose rows turn out unchanged, so nothing downstream repaints', () => {
    const cache = createVersionedSourceCache<{ n: number }>(16, memoName('test.both'));
    const build = jest.fn(() => ({ n: 1 }));
    const first = cache.put('row', 1, 'a', build);

    const second = cache.put('row', 2, 'a', build);

    expect(second).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);
    // The entry moved to the new version, so the next read at it is a peek hit rather than another query.
    expect(cache.peek('row', 2)?.value).toBe(first);
  });

  it('rebuilds when the bump did change the rows', () => {
    const cache = createVersionedSourceCache<{ n: number }>(16, memoName('test.both'));
    const first = cache.put('row', 1, 'a', () => ({ n: 1 }));

    const second = cache.put('row', 2, 'b', () => ({ n: 2 }));

    expect(second).not.toBe(first);
    expect(second.n).toBe(2);
  });

  it('caches a built undefined, which is what a nullable point read stores for a player with no rows', () => {
    const cache = createVersionedSourceCache<{ n: number } | undefined>(16, memoName('test.both'));
    const build = jest.fn(() => undefined);

    cache.put('row', 1, '', build);

    expect(cache.peek('row', 1)).toEqual({ version: 1, source: '', value: undefined });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('keys per entry, so one row changing leaves its neighbour reference-stable', () => {
    const cache = createVersionedSourceCache<{ n: number }>(16, memoName('test.both'));
    const entryA = cache.put('a', 1, 'a1', () => ({ n: 1 }));
    const entryB = cache.put('b', 1, 'b1', () => ({ n: 2 }));

    cache.put('a', 2, 'a2', () => ({ n: 3 }));

    expect(cache.put('b', 2, 'b1', () => ({ n: 2 }))).toBe(entryB);
    expect(cache.put('a', 2, 'a2', () => ({ n: 3 }))).not.toBe(entryA);
  });

  it('evicts the least-recently-used entry past maxEntries', () => {
    const cache = createVersionedSourceCache<{ n: number }>(2, memoName('test.both'));
    const entryA = cache.put('a', 1, 's', () => ({ n: 1 }));
    cache.put('b', 1, 's', () => ({ n: 2 }));
    cache.put('a', 1, 's', () => ({ n: 1 })); // touch 'a' so 'b' is the LRU
    cache.put('c', 1, 's', () => ({ n: 3 }));

    expect(cache.peek('a', 1)?.value).toBe(entryA);
    expect(cache.peek('b', 1)).toBeUndefined();
  });

  describe('reporting on itself', () => {
    let warnings: string[];

    beforeEach(() => {
      resetOnceGuards();
      warnings = [];
      jest.spyOn(console, 'warn').mockImplementation((message) => warnings.push(String(message)));
    });
    afterEach(() => jest.restoreAllMocks());

    const of = (report: string) => warnings.filter((warning) => warning.includes(report));

    /** Cycles `keys` distinct entries through a cache too small to hold them, `rounds` times over. */
    const thrash = (cache: VersionedSourceCache<{ n: number }>, keys: number, rounds: number) => {
      for (let round = 0; round < rounds; round += 1) {
        for (let key = 0; key < keys; key += 1) cache.put(`k${key}`, 1, 's', () => ({ n: key }));
      }
    };

    it('stays quiet about its size while it only rotates through keys that never come back', () => {
      const cache = createVersionedSourceCache<{ n: number }>(8, memoName('test.rotating'));

      for (let key = 0; key < 4000; key += 1) cache.put(`k${key}`, 1, 's', () => ({ n: key }));

      expect(of('undersized')).toEqual([]);
    });

    itDev('reports one too small for the keys it keeps being asked for again', () => {
      const cache = createVersionedSourceCache<{ n: number }>(8, memoName('test.undersized'));

      thrash(cache, 16, 40);

      expect(of('memo.undersized.test.undersized')).toHaveLength(1);
    });

    itDev('reports one that has never once answered from its entry', () => {
      const { deadWeight } = declareMemos('test', { deadWeight: byVersion<number>({ max: 4096, keyedBy: 'a key that never repeats' }) });

      for (let key = 0; key < 512; key += 1) deadWeight.read(`k${key}`, 1, () => key);

      expect(warnings).toEqual([expect.stringContaining('memo.never_hit.test.deadWeight')]);
      expect(warnings[0]).toContain('a key that never repeats');
    });

    itDev('says nothing about one whose keys come back', () => {
      const { earning } = declareMemos('test', { earning: bySource<number>({ max: 4096, keyedBy: 'a key that repeats' }) });

      for (let key = 0; key < 4000; key += 1) earning.put('k', 1, 's', () => key);

      expect(warnings).toEqual([]);
    });
  });
});

describe('shallowEqualStruct', () => {
  interface Row {
    id: string;
    score: number | null;
    tags: string[] | null;
    stats: Record<string, number | null>;
    detail?: { n: number };
  }

  const row = (over?: Partial<Row>): Row => ({ id: 'p1', score: 1, tags: ['QB'], stats: { pass_yd: 300 }, ...over });
  const same = shallowEqualStruct<Row>({
    tags: (left, right) => left === right || (!!left && !!right && shallowEqualArray(left, right)),
    stats: shallowEqualRecord,
  });

  it('takes two rebuilt rows with the same contents as unchanged', () => {
    expect(same(row(), row())).toBe(true);
  });

  it('compares a field it was told nothing about with Object.is', () => {
    expect(same(row({ score: 2 }), row())).toBe(false);
    expect(same(row({ score: null }), row({ score: null }))).toBe(true);
  });

  it('runs the check a field was named with, so equal contents behind a new reference hold', () => {
    expect(same(row({ tags: ['QB'] }), row({ tags: ['QB'] }))).toBe(true);
    expect(same(row({ tags: ['QB'] }), row({ tags: ['RB'] }))).toBe(false);
    expect(same(row({ tags: null }), row({ tags: null }))).toBe(true);
    expect(same(row({ tags: null }), row({ tags: [] }))).toBe(false);
    expect(same(row({ stats: { pass_yd: 300 } }), row({ stats: { pass_yd: 301 } }))).toBe(false);
  });

  it('reads a field it holds no check for as changed once it holds an object', () => {
    // The safe direction: an unnamed object field costs a repaint, where taking it as equal would hand back a stale row.
    expect(same(row({ detail: { n: 1 } }), row({ detail: { n: 1 } }))).toBe(false);
  });

  it('reads a row that gained a field as changed', () => {
    expect(same(row({ detail: { n: 1 } }), row())).toBe(false);
  });
});

describe('sqlite_connection', () => {
  function makeConn(withBatch: boolean): { conn: SqliteConnection; log: string[] } {
    const log: string[] = [];
    const conn: SqliteConnection = {
      execute(sql: string) {
        log.push(sql);
        return { rows: { _array: [] } };
      },
    };
    if (withBatch) {
      conn.executeBatch = (commands) => {
        for (const [sql] of commands) log.push(`batch:${sql}`);
      };
    }
    return { conn, log };
  }

  const commands: BatchCommand[] = [
    ['INSERT 1;', []],
    ['INSERT 2;', []],
  ];

  it('uses executeBatch when available', () => {
    const { conn, log } = makeConn(true);
    runBatch(conn, commands);
    expect(log).toEqual(['batch:INSERT 1;', 'batch:INSERT 2;']);
  });

  it('falls back to an explicit BEGIN/COMMIT transaction', () => {
    const { conn, log } = makeConn(false);
    runBatch(conn, commands);
    expect(log).toEqual(['BEGIN;', 'INSERT 1;', 'INSERT 2;', 'COMMIT;']);
  });

  it('rolls back the sync fallback on error', () => {
    const log: string[] = [];
    const conn: SqliteConnection = {
      execute(sql: string) {
        log.push(sql);
        if (sql === 'BOOM;') throw new Error('fail');
        return { rows: { _array: [] } };
      },
    };
    expect(() => runBatch(conn, [['BOOM;', []]])).toThrow('fail');
    expect(log).toEqual(['BEGIN;', 'BOOM;', 'ROLLBACK;']);
  });

  it('runBatchAsync prefers executeBatchAsync, else falls back to sync', async () => {
    const asyncLog: string[] = [];
    const conn: SqliteConnection = {
      execute: () => ({ rows: { _array: [] } }),
      executeBatchAsync: async (cmds) => {
        for (const [sql] of cmds) asyncLog.push(sql);
      },
    };
    await runBatchAsync(conn, commands);
    expect(asyncLog).toEqual(['INSERT 1;', 'INSERT 2;']);

    const { conn: syncConn, log } = makeConn(false);
    await runBatchAsync(syncConn, commands);
    expect(log).toEqual(['BEGIN;', 'INSERT 1;', 'INSERT 2;', 'COMMIT;']);
  });

  it('readRows returns the _array typed, empty when missing', () => {
    const conn: SqliteConnection = { execute: () => ({ rows: { _array: [{ a: 1 }] } }) };
    expect(readRows<{ a: number }>(conn, 'SELECT 1;')).toEqual([{ a: 1 }]);
    const emptyConn: SqliteConnection = { execute: () => ({}) };
    expect(readRows(emptyConn, 'SELECT 1;')).toEqual([]);
  });

  it('readRows disposes the native QueryResult after extracting rows (releases external memory eagerly)', () => {
    let disposed = 0;
    const rows = [{ a: 1 }];
    const conn: SqliteConnection = { execute: () => ({ rows: { _array: rows }, dispose: () => (disposed += 1) }) };
    expect(readRows<{ a: number }>(conn, 'SELECT 1;')).toEqual([{ a: 1 }]);
    expect(disposed).toBe(1);
  });
});
