import { RowTable } from '../../table/types';
import { createPushIngest } from '../../write/push_ingest';
import { resetOnceGuards } from '../../diagnostics/once_guard';
import { ChangeSet, NO_CHANGES } from '../../table/change_set';

interface Item {
  id: string;
  value: number;
}

interface Row {
  [key: string]: string | number | undefined;
  id: string;
  partition_key: string;
  value: number;
}

function makeTable() {
  const batches: Row[][] = [];
  const replaced: { scope: Partial<Row>; rows: Row[] }[] = [];
  let failures = 0;
  /** Ids whose next push repeats what the table holds, so the table reports them unchanged. */
  const unchanged = new Set<string>();
  const table = {
    upsert: jest.fn(async (rows: readonly Row[]) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('write failed');
      }
      batches.push([...rows]);
      const changed = new Set(rows.map((row) => row.id).filter((id) => !unchanged.has(id)));
      return { changes: changed.size ? changed : NO_CHANGES, rows: rows.length };
    }),
    overwrite: jest.fn((scope: Partial<Row>, rows: readonly Row[]) => {
      replaced.push({ scope, rows: [...rows] });
      return rows.length;
    }),
  };
  return {
    table: table as unknown as RowTable<Row>,
    batches,
    replaced,
    upsert: table.upsert,
    failNext: (count: number) => {
      failures = count;
    },
    repeatWhatIsHeld: (...ids: string[]) => ids.forEach((id) => unchanged.add(id)),
  };
}

function setup(over: { chunk?: number; retryDelayMs?: number } = {}) {
  const harness = makeTable();
  const bumps: string[] = [];
  const bumpedWith: ChangeSet[] = [];
  const writes: string[] = [];
  const push = createPushIngest<Item, Row, string>({
    name: 'test_store',
    table: harness.table,
    where: (key) => ({ partition_key: key }),
    idOf: (item) => item.id,
    toRows: (key, items) => items.map((index) => ({ id: index.id, partition_key: key, value: index.value })),
    bump: (key, changes) => {
      bumps.push(key);
      bumpedWith.push(changes);
    },
    onWrite: (key) => writes.push(key),
    chunk: over.chunk ?? 2,
    retryDelayMs: over.retryDelayMs ?? 1000,
  });
  return { ...harness, push, bumps, bumpedWith, writes };
}

/** The flush is a 0ms timer plus an async write, so both the timer queue and the microtask queue have to drain. */
const flush = async (ms = 0) => {
  await jest.advanceTimersByTimeAsync(ms);
};

describe('create_push_ingest', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // A degradation report fires once per scope per process, so this reset is what lets the second failure case report.
    resetOnceGuards();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('coalesces a burst into one write per partition and wakes each reader once', async () => {
    const harness = setup({ chunk: 10 });
    harness.push.queue('us:1', { id: 'a', value: 1 });
    harness.push.queue('us:1', { id: 'b', value: 2 });
    harness.push.queue('us:2', { id: 'c', value: 3 });

    expect(harness.upsert).not.toHaveBeenCalled();
    await flush();

    expect(harness.batches).toEqual([
      [
        { id: 'a', partition_key: 'us:1', value: 1 },
        { id: 'b', partition_key: 'us:1', value: 2 },
      ],
      [{ id: 'c', partition_key: 'us:2', value: 3 }],
    ]);
    expect(harness.bumps).toEqual(['us:1', 'us:2']);
    expect(harness.writes).toEqual(['us:1', 'us:2']);
  });

  it('bumps each partition with the units its flush changed, chunks included', async () => {
    const harness = setup({ chunk: 1 });
    harness.push.queue('us:1', { id: 'a', value: 1 });
    harness.push.queue('us:1', { id: 'b', value: 2 });
    await flush();

    expect(harness.upsert).toHaveBeenCalledTimes(2);
    expect(harness.bumps).toEqual(['us:1']);
    expect([...(harness.bumpedWith[0] as ReadonlySet<string>)].sort()).toEqual(['a', 'b']);
  });

  it('wakes nobody and keeps the etag for a push that repeats what the table already holds', async () => {
    const harness = setup();
    harness.repeatWhatIsHeld('a');
    harness.push.queue('us:1', { id: 'a', value: 1 });
    await flush();

    expect(harness.upsert).toHaveBeenCalledTimes(1);
    expect(harness.bumps).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it('keeps the last item under an id, so a burst repeating one thing is still one row', async () => {
    const harness = setup();
    harness.push.queue('us:1', { id: 'a', value: 1 });
    harness.push.queue('us:1', { id: 'a', value: 9 });
    await flush();

    expect(harness.batches).toEqual([[{ id: 'a', partition_key: 'us:1', value: 9 }]]);
  });

  it('splits a partition into chunks of the configured size', async () => {
    const harness = setup({ chunk: 2 });
    for (const id of ['a', 'b', 'c']) harness.push.queue('us:1', { id, value: 1 });
    await flush();

    expect(harness.batches.map((batch) => batch.length)).toEqual([2, 1]);
    expect(harness.bumps).toEqual(['us:1']);
  });

  describe('holds', () => {
    it('buffers a held partition and writes it on release', async () => {
      const harness = setup();
      const release = harness.push.hold('us:1');
      harness.push.queue('us:1', { id: 'a', value: 1 });
      await flush();
      expect(harness.upsert).not.toHaveBeenCalled();

      release();
      await flush();
      expect(harness.batches).toEqual([[{ id: 'a', partition_key: 'us:1', value: 1 }]]);
    });

    it('does not hold up a partition nobody is fetching', async () => {
      const harness = setup();
      harness.push.hold('us:1');
      harness.push.queue('us:1', { id: 'a', value: 1 });
      harness.push.queue('us:2', { id: 'b', value: 2 });
      await flush();

      expect(harness.bumps).toEqual(['us:2']);
    });

    it('is reference-counted, so overlapping fetches both have to finish', async () => {
      const harness = setup();
      const first = harness.push.hold('us:1');
      const second = harness.push.hold('us:1');
      harness.push.queue('us:1', { id: 'a', value: 1 });

      first();
      await flush();
      expect(harness.upsert).not.toHaveBeenCalled();

      second();
      await flush();
      expect(harness.bumps).toEqual(['us:1']);
    });

    it('ignores a release called twice, so one fetch cannot unhold another', async () => {
      const harness = setup();
      const first = harness.push.hold('us:1');
      harness.push.hold('us:1');
      harness.push.queue('us:1', { id: 'a', value: 1 });

      first();
      first();
      await flush();
      expect(harness.upsert).not.toHaveBeenCalled();
    });
  });

  describe('failure', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      // The console is where a degradation surfaces in development; a release build files it to the reporter instead.
      if (__DEV__) expect(warn).toHaveBeenCalledWith(expect.stringContaining('test_store.flush'), expect.anything(), expect.anything());
      warn.mockRestore();
    });

    it('requeues a failed batch and retries it after the delay', async () => {
      const harness = setup({ chunk: 10, retryDelayMs: 1000 });
      harness.failNext(1);
      harness.push.queue('us:1', { id: 'a', value: 1 });

      await flush();
      expect(harness.batches).toEqual([]);
      expect(harness.bumps).toEqual([]);

      await flush(1000);
      expect(harness.batches).toEqual([[{ id: 'a', partition_key: 'us:1', value: 1 }]]);
      expect(harness.bumps).toEqual(['us:1']);
    });

    it('lets a newer push win over the one being retried', async () => {
      const harness = setup({ chunk: 10, retryDelayMs: 1000 });
      harness.failNext(1);
      harness.push.queue('us:1', { id: 'a', value: 1 });
      await flush();

      harness.push.queue('us:1', { id: 'a', value: 99 });
      await flush(1000);

      expect(harness.batches).toEqual([[{ id: 'a', partition_key: 'us:1', value: 99 }]]);
    });
  });
});
