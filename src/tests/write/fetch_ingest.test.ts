import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { installTestRuntime } from '../../testing/runtime';
import { createFetchIngest, FetchIngestConfig, RawFetchResponse, RAW_TEXT_RESPONSE_TRANSFORM } from '../../write/fetch_ingest';
import { VersionAtom } from '../../reactivity/version_atom';
import { clearIngestTimings, getIngestTimings, rollupIngestTimings } from '../../diagnostics/ingest_timing';

/* global globalThis */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Probe<T> = { current: T; rerender: () => void; unmount: () => void };
function renderHook<T>(useHook: () => T): Probe<T> {
  const probe: Probe<T> = { current: undefined as unknown as T, rerender: () => {}, unmount: () => {} };
  const Component = () => {
    probe.current = useHook();
    return null;
  };
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Component));
  });
  probe.rerender = () =>
    act(() => {
      renderer.update(React.createElement(Component));
    });
  probe.unmount = () =>
    act(() => {
      renderer.unmount();
    });
  return probe;
}

const runtime = installTestRuntime();
const fetchQueryMock = runtime.fetchQuery;
const useFocusGatedQueryMock = runtime.useQuery;
const useFocusGatedQueriesMock = runtime.useQueries;

function makeCfg(over: Partial<FetchIngestConfig<string>> = {}) {
  const state = { etag: undefined as string | undefined, version: 0 };
  let queryResponse: RawFetchResponse | undefined = { data: '[]', etag: undefined };
  let queryReject: unknown;

  const rawQueryFn = jest.fn(async (): Promise<RawFetchResponse | undefined> => {
    if (queryReject !== undefined) throw queryReject;
    return queryResponse;
  });

  const version = {
    get: jest.fn(() => state.version),
    bump: jest.fn(() => {
      state.version += 1;
      return state.version;
    }),
  } as unknown as VersionAtom;

  const cfg: FetchIngestConfig<string> = {
    ingestKeyRoot: 'test_ingest',
    toParts: (key) => [key],
    version,
    rawQuery: jest.fn(() => ({ queryFn: rawQueryFn, staleTime: 1000, cacheTime: 2000 })),
    getEtag: jest.fn(() => state.etag),
    setEtag: jest.fn((_key, etag) => {
      state.etag = etag;
    }),
    ingestRaw: jest.fn(async () => 5),
    ...over,
  };

  return {
    cfg,
    version,
    state,
    rawQueryFn,
    setResponse: (response: RawFetchResponse | undefined) => {
      queryResponse = response;
      queryReject = undefined;
    },
    setReject: (error: unknown) => {
      queryReject = error;
    },
  };
}

beforeEach(() => {
  fetchQueryMock.mockClear();
  useFocusGatedQueryMock.mockClear();
  useFocusGatedQueriesMock.mockClear();
  clearIngestTimings();
});

describe('createFetchIngest — 304 / etag short-circuit', () => {
  it('skips the shred, etag persist, and version bump when the API reports __etagMatch', async () => {
    const harness = makeCfg();
    harness.state.etag = 'W/"prev"';
    harness.state.version = 7;
    harness.setResponse({ __etagMatch: true });
    const ingest = createFetchIngest(harness.cfg);

    const out = await ingest.prefetch('nfl');

    expect(harness.cfg.ingestRaw).not.toHaveBeenCalled();
    expect(harness.cfg.setEtag).not.toHaveBeenCalled();
    expect(harness.version.bump).not.toHaveBeenCalled();
    expect(out).toEqual({ version: 7, count: -1 });
  });

  it('forwards the persisted etag into the raw query (conditional fetch)', async () => {
    const harness = makeCfg();
    harness.state.etag = 'W/"abc"';
    harness.setResponse({ __etagMatch: true });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('nfl');

    expect(harness.cfg.getEtag).toHaveBeenCalledWith('nfl');
    expect(harness.cfg.rawQuery).toHaveBeenCalledWith('nfl', 'W/"abc"');
  });
});

describe('createFetchIngest — ingest timing', () => {
  /** `Date.now()` is read at the start, after the fetch, and after the shred. */
  const mockClock = (...times: number[]) => {
    let index = 0;
    return jest.spyOn(Date, 'now').mockImplementation(() => times[Math.min(index++, times.length - 1)]);
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('splits the wait into the fetch and the shred that follows it', async () => {
    mockClock(1_000, 1_120, 2_020);
    const harness = makeCfg();
    harness.setResponse({ data: '[{"id":1}]', etag: 'W/"new"' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('nfl');

    const [timing] = getIngestTimings();
    expect(timing.fetchMs).toBe(120);
    expect(timing.ingestMs).toBe(900);
  });

  it('records the body size and row count, so a slow shred can be read against how much it shredded', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"id":1}]' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('nfl');

    const [timing] = getIngestTimings();
    expect(timing.chars).toBe('[{"id":1}]'.length);
    expect(timing.rows).toBe(5);
    expect(timing.store).toBe('test_ingest');
    expect(timing.partition).toBe('nfl');
  });

  it('records a 304 as a fetch that shred nothing, so a cheap launch is not mistaken for a missing ingest', async () => {
    mockClock(1_000, 1_120, 1_120);
    const harness = makeCfg();
    harness.setResponse({ __etagMatch: true });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('nfl');

    const [timing] = getIngestTimings();
    expect(timing.ingestMs).toBe(0);
    expect(timing.rows).toBe(-1);
    expect(timing.chars).toBeNull();
  });

  it('rolls up totals per store', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"id":1}]' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('nfl');
    await ingest.prefetch('nba');

    const [roll] = rollupIngestTimings();
    expect(roll.store).toBe('test_ingest');
    expect(roll.fetches).toBe(2);
    expect(roll.rows).toBe(10);
  });

  it('does not count an etag match toward rows, which would inflate what the store actually shredded', async () => {
    const harness = makeCfg();
    harness.setResponse({ __etagMatch: true });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('nfl');

    const [roll] = rollupIngestTimings();
    expect(roll.rows).toBe(0);
    expect(roll.fetches).toBe(1);
  });
});

describe('createFetchIngest — holdWrites', () => {
  function makeHeld() {
    const order: string[] = [];
    const release = jest.fn(() => {
      order.push('release');
    });
    const holdWrites = jest.fn(() => {
      order.push('hold');
      return release;
    });
    return { order, release, holdWrites };
  }

  it('holds before the request goes out and releases only after the rows are in', async () => {
    const held = makeHeld();
    const harness = makeCfg({ holdWrites: held.holdWrites });
    harness.cfg.rawQuery = jest.fn(() => ({
      queryFn: async () => {
        held.order.push('request');
        return { data: '[{"player_id":"a"}]' };
      },
    }));
    harness.cfg.ingestRaw = jest.fn(async () => {
      held.order.push('ingest');
      return 1;
    });

    await createFetchIngest(harness.cfg).prefetch('nfl');

    expect(held.holdWrites).toHaveBeenCalledWith('nfl');
    expect(held.order).toEqual(['hold', 'request', 'ingest', 'release']);
  });

  it('releases on a 304, which ingests nothing but still held the partition', async () => {
    const held = makeHeld();
    const harness = makeCfg({ holdWrites: held.holdWrites });
    harness.setResponse({ __etagMatch: true });

    await createFetchIngest(harness.cfg).prefetch('nfl');

    expect(held.order).toEqual(['hold', 'release']);
  });

  it('releases on a failed request, so a dead partition does not wedge the other writer', async () => {
    const held = makeHeld();
    const harness = makeCfg({ holdWrites: held.holdWrites });
    harness.setReject(new Error('offline'));

    await expect(createFetchIngest(harness.cfg).prefetch('nfl')).rejects.toThrow('offline');

    expect(held.release).toHaveBeenCalledTimes(1);
  });
});

describe('createFetchIngest — successful ingest (200)', () => {
  it('shreds the raw text, persists the new etag, and bumps the version once', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"player_id":"a"}]', etag: 'W/"new"' });
    const ingest = createFetchIngest(harness.cfg);

    const out = await ingest.prefetch('nfl');

    expect(harness.cfg.ingestRaw).toHaveBeenCalledWith('nfl', '[{"player_id":"a"}]');
    expect(harness.cfg.setEtag).toHaveBeenCalledWith('nfl', 'W/"new"');
    expect(harness.version.bump).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ version: 1, count: 5 });
  });

  it('coerces a non-string (object) body to JSON text before shredding', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: { players: [1, 2] }, etag: 'e' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('nfl');

    expect(harness.cfg.ingestRaw).toHaveBeenCalledWith('nfl', JSON.stringify({ players: [1, 2] }));
  });

  it('bumps but refuses the etag from a 200 that carried no body, so the next launch is a real fetch', async () => {
    const harness = makeCfg();
    harness.setResponse({ etag: 'e' });
    const ingest = createFetchIngest(harness.cfg);

    const out = await ingest.prefetch('nfl');

    expect(harness.cfg.ingestRaw).not.toHaveBeenCalled();
    expect(harness.cfg.setEtag).not.toHaveBeenCalled();
    expect(out).toEqual({ version: 1, count: 0 });
  });

  it('persists the etag for a body that held no rows, which is a partition that is genuinely empty', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[]', etag: 'e' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('nfl');

    expect(harness.cfg.ingestRaw).toHaveBeenCalledWith('nfl', '[]');
    expect(harness.cfg.setEtag).toHaveBeenCalledWith('nfl', 'e');
  });

  it('refuses the etag for an empty-string body too, which is the same nothing as a missing one', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '', etag: 'e' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('nfl');

    expect(harness.cfg.setEtag).not.toHaveBeenCalled();
  });

  it('does not persist an etag the response omitted', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[]' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('nfl');

    expect(harness.cfg.setEtag).not.toHaveBeenCalled();
    expect(harness.version.bump).toHaveBeenCalledTimes(1);
  });
});

describe('createFetchIngest — prefetch / ensure gating', () => {
  it('short-circuits (no fetch) when any partition part is falsy', async () => {
    const harness = makeCfg();
    harness.state.version = 3;
    const ingest = createFetchIngest(harness.cfg);

    const out = await ingest.prefetch('');

    expect(harness.rawQueryFn).not.toHaveBeenCalled();
    expect(fetchQueryMock).not.toHaveBeenCalled();
    expect(out).toEqual({ version: 3, count: 0 });
  });

  it('passes the store staleTime by default and a caller override when given', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[]', etag: 'e' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('nfl');
    expect(fetchQueryMock.mock.calls[0][0].staleTime).toBe(1000);

    await ingest.prefetch('nfl', { staleTime: 50 });
    expect(fetchQueryMock.mock.calls[1][0].staleTime).toBe(50);
  });

  it('ensure runs the same flow and swallows a fetch error (best-effort auto-prime)', async () => {
    const harness = makeCfg();
    harness.setReject(new Error('network down'));
    const ingest = createFetchIngest(harness.cfg);

    expect(() => ingest.ensure('nfl')).not.toThrow();
    await new Promise((response) => {
      setTimeout(response, 0);
    });
    expect(fetchQueryMock).toHaveBeenCalledTimes(1);

    await expect(ingest.prefetch('nfl')).rejects.toThrow('network down');
  });
});

describe('createFetchIngest — usePrime (reactive wiring)', () => {
  it('wires the focus-gated query with the partition key, timings, and narrow notify props', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    const res = ingest.usePrime('nfl');

    const config = useFocusGatedQueryMock.mock.calls[0][0];
    expect(config.queryKey).toEqual(['test_ingest', 'nfl']);
    expect(config.enabled).toBe(true);
    expect(config.staleTime).toBe(1000);
    expect(config.cacheTime).toBe(2000);
    // Must include `isError`, or a failed fetch never re-renders the read that would report it.
    expect(config.notifyOnChangeProps).toEqual(['isInitialLoading', 'isFetching', 'isError']);
    expect(res).toEqual({ isInitialLoading: false, isFetching: false, isError: false });
  });

  it('disables the query when a part is falsy, or when explicitly disabled', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    ingest.usePrime('');
    expect(useFocusGatedQueryMock.mock.calls[0][0].enabled).toBe(false);

    ingest.usePrime('nfl', false);
    expect(useFocusGatedQueryMock.mock.calls[1][0].enabled).toBe(false);
  });

  it("the query's queryFn runs the same ingest flow (shred + bump)", async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"x":1}]', etag: 'e' });
    const ingest = createFetchIngest(harness.cfg);

    ingest.usePrime('nfl');
    const { queryFn } = useFocusGatedQueryMock.mock.calls[0][0];
    const out = await queryFn();

    expect(harness.cfg.ingestRaw).toHaveBeenCalledWith('nfl', '[{"x":1}]');
    expect(out).toEqual({ version: 1, count: 5 });
  });

  it('renders on default timings when `rawQuery` throws, and still fails the fetch itself', async () => {
    const unknown = new Error('unknown partition');
    const harness = makeCfg({
      rawQuery: jest.fn(() => {
        throw unknown;
      }),
    });
    const ingest = createFetchIngest(harness.cfg);

    expect(() => ingest.usePrime('nfl')).not.toThrow();

    const config = useFocusGatedQueryMock.mock.calls[0][0];
    expect(config.staleTime).toBeUndefined();
    expect(config.cacheTime).toBeUndefined();
    await expect(config.queryFn()).rejects.toThrow(unknown);
  });
});

describe('createFetchIngest — usePrimeMany (a partition set whose size varies per render)', () => {
  it('runs one query per partition through a single hook, so the count can change between renders', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    renderHook(() => ingest.usePrimeMany(['nfl', 'nba']));
    const first = useFocusGatedQueriesMock.mock.calls[0][0].queries;
    expect(first.map((query: { queryKey: string[] }) => query.queryKey)).toEqual([
      ['test_ingest', 'nfl'],
      ['test_ingest', 'nba'],
    ]);
    expect(first[0].notifyOnChangeProps).toEqual(['isInitialLoading', 'isFetching', 'isError']);

    renderHook(() => ingest.usePrimeMany(['nfl']));
    expect(useFocusGatedQueriesMock.mock.calls[1][0].queries).toHaveLength(1);
  });

  it('skips a partition with a falsy part rather than fetching a nonsense key', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    renderHook(() => ingest.usePrimeMany(['nfl', '']));

    expect(useFocusGatedQueriesMock.mock.calls[0][0].queries).toHaveLength(1);
  });

  it('disables every query at once when the read is disabled', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    renderHook(() => ingest.usePrimeMany(['nfl', 'nba'], false));

    expect(useFocusGatedQueriesMock.mock.calls[0][0].queries.every((query: { enabled: boolean }) => !query.enabled)).toBe(true);
  });

  it('reports loading while any one partition is still on its first fetch', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);
    useFocusGatedQueriesMock.mockReturnValueOnce([{ isInitialLoading: false }, { isInitialLoading: true }]);

    expect(renderHook(() => ingest.usePrimeMany(['nfl', 'nba'])).current).toEqual({ isInitialLoading: true, isFetching: false, isError: false });
  });

  it('reports fetching while any one partition refreshes, even though none is initially loading', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);
    useFocusGatedQueriesMock.mockReturnValueOnce([
      { isInitialLoading: false, isFetching: false },
      { isInitialLoading: false, isFetching: true },
    ]);

    expect(renderHook(() => ingest.usePrimeMany(['nfl', 'nba'])).current).toEqual({ isInitialLoading: false, isFetching: true, isError: false });
  });

  it('reports error only when every partition failed, so one bad partition degrades to a gap', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    useFocusGatedQueriesMock.mockReturnValueOnce([{ isError: true }, { isError: false }]);
    expect(renderHook(() => ingest.usePrimeMany(['nfl', 'nba'])).current.isError).toBe(false);

    useFocusGatedQueriesMock.mockReturnValueOnce([{ isError: true }, { isError: true }]);
    expect(renderHook(() => ingest.usePrimeMany(['nfl', 'nba'])).current.isError).toBe(true);
  });

  it('reports no error for an empty partition set, so a list with nothing live is not an error', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);
    useFocusGatedQueriesMock.mockReturnValueOnce([]);

    expect(renderHook(() => ingest.usePrimeMany([''])).current).toEqual({ isInitialLoading: false, isFetching: false, isError: false });
  });

  it('hands the same queries array back across a re-render with an equal partition set', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    // A fresh array each render, as `def.partitions(args)` produces.
    const probe = renderHook(() => ingest.usePrimeMany(['nfl', 'nba']));
    probe.rerender();
    probe.rerender();

    const [first, second, third] = useFocusGatedQueriesMock.mock.calls.map((call) => call[0].queries);
    expect(second).toBe(first);
    expect(third).toBe(first);
    probe.unmount();
  });

  it('builds each partition’s raw query once, not once per render', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    const probe = renderHook(() => ingest.usePrimeMany(['nfl', 'nba']));
    (harness.cfg.rawQuery as jest.Mock).mockClear();
    probe.rerender();

    expect(harness.cfg.rawQuery).not.toHaveBeenCalled();
    probe.unmount();
  });

  it('rebuilds when the partition set actually changes, so a new partition is still fetched', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    let partitions: string[] = ['nfl'];
    const probe = renderHook(() => ingest.usePrimeMany(partitions));
    partitions = ['nfl', 'nba'];
    probe.rerender();

    const [first, second] = useFocusGatedQueriesMock.mock.calls.map((call) => call[0].queries);
    expect(second).not.toBe(first);
    expect(second.map((query: { queryKey: string[] }) => query.queryKey)).toEqual([
      ['test_ingest', 'nfl'],
      ['test_ingest', 'nba'],
    ]);
    probe.unmount();
  });

  it('rebuilds when `enabled` flips, which is carried on the query objects themselves', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    let enabled = true;
    const probe = renderHook(() => ingest.usePrimeMany(['nfl'], enabled));
    enabled = false;
    probe.rerender();

    const [first, second] = useFocusGatedQueriesMock.mock.calls.map((call) => call[0].queries);
    expect(second).not.toBe(first);
    expect(second[0].enabled).toBe(false);
    probe.unmount();
  });

  it("each query's queryFn runs the same ingest flow as usePrime's", async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"x":1}]', etag: 'e' });
    const ingest = createFetchIngest(harness.cfg);

    renderHook(() => ingest.usePrimeMany(['nfl']));
    const out = await useFocusGatedQueriesMock.mock.calls[0][0].queries[0].queryFn();

    expect(harness.cfg.ingestRaw).toHaveBeenCalledWith('nfl', '[{"x":1}]');
    expect(out).toEqual({ version: 1, count: 5 });
  });
});

describe('forget', () => {
  it('drops every partition this store has fetched, not just one', () => {
    const harness = makeCfg();
    createFetchIngest(harness.cfg).forget();

    expect(runtime.removeQueries).toHaveBeenCalledWith({ queryKey: ['test_ingest'] });
  });

  it('removes rather than invalidates, so a mounted reader stops showing rows the store no longer has', () => {
    const harness = makeCfg();
    createFetchIngest(harness.cfg).forget();

    expect(runtime.invalidateQueries).not.toHaveBeenCalled();
  });
});

describe('RAW_TEXT_RESPONSE_TRANSFORM', () => {
  it('is a single identity transform (keeps the raw body as text for the native shred)', () => {
    expect(RAW_TEXT_RESPONSE_TRANSFORM).toHaveLength(1);
    const body = '{"big":"payload"}';
    expect(RAW_TEXT_RESPONSE_TRANSFORM[0](body)).toBe(body);
  });
});
