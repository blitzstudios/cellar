import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { createReadSurface, ReadDef, ReadSurfaceKernel } from '../../read/surface';
import { VaryValue } from '../../args_key';
import { createVersionAtom } from '../../reactivity/version_atom';
import { shallowEqualRecord } from '../../caches';
import { runTracked } from '../../reactivity/tracking';

/* global globalThis */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Probe<T> = { current: T; renders: number; rerender: () => void; unmount: () => void };
function renderHook<T>(useHook: () => T): Probe<T> {
  const probe: Probe<T> = { current: undefined as unknown as T, renders: 0, rerender: () => {}, unmount: () => {} };
  const Component = () => {
    probe.current = useHook();
    probe.renders += 1;
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

type Row = { score: number };
type Slice = Record<string, Row>;
/** A read whose args carry one vary value beyond its partition, for the tests that exercise the gate. */
type ScopedArgs = { key: string; id?: VaryValue };

function makeHarness() {
  const atom = createVersionAtom('read_surface_test_version');
  const slices = new Map<string, Slice>();
  const present = new Set<string>();
  const failed = new Set<string>();
  const fetchedAt = new Map<string, number>();
  const spies = {
    ensure: [] as string[],
    usePrime: [] as { key: string; enabled: boolean }[],
    usePrimeMany: [] as { keys: string[]; enabled: boolean }[],
    refetch: [] as string[],
    has: [] as string[],
  };

  const kernel: ReadSurfaceKernel<string> = {
    version: atom,
    toParts: (key) => [key],
    has: (key) => {
      spies.has.push(key);
      return present.has(key);
    },
    ingest: {
      usePrime: (key, enabled) => {
        spies.usePrime.push({ key: key as string, enabled });
        const isError = enabled && !!key && failed.has(key);
        const isInitialLoading = enabled && !isError && !(!!key && present.has(key));
        return { isInitialLoading, isFetching: isInitialLoading, isError };
      },
      usePrimeMany: (allKeys, enabled) => {
        const keys = allKeys.filter(Boolean);
        spies.usePrimeMany.push({ keys, enabled });
        const isError = enabled && keys.length > 0 && keys.every((key) => failed.has(key));
        const isInitialLoading = enabled && !isError && keys.some((key) => !present.has(key));
        return { isInitialLoading, isFetching: isInitialLoading, isError };
      },
      ensure: (key) => spies.ensure.push(key),
      refetch: (key) => spies.refetch.push(key),
    },
  };

  const EMPTY: Slice = {};
  const surface = createReadSurface(kernel);
  // The shape most of these tests take, applied once, so a test hands over a def and nothing else.
  const read = surface.read<{ key: string }, Slice>();
  const sliceDef: ReadDef<{ key: string }, string, Slice> = {
    partition: (args) => args.key,
    select: (_args, key) => slices.get(key) ?? EMPTY,
    empty: EMPTY,
    isEqual: shallowEqualRecord,
  };

  const land = (key: string, slice: Slice, at = 1000) => {
    slices.set(key, slice);
    present.add(key);
    failed.delete(key);
    fetchedAt.set(key, at);
    act(() => {
      atom.bump([key]);
    });
  };

  const fail = (key: string) => {
    failed.add(key);
  };

  return { atom, slices, present, failed, fetchedAt, spies, kernel, EMPTY, surface, read, sliceDef, land, fail };
}

describe('createReadSurface — getValue registers its partition with the tracking scope', () => {
  const depsOf = (fn: () => unknown): string[] => runTracked(fn).deps.map((dep) => dep.id);

  it('on a cache hit, which is the read that would otherwise look like it touched nothing', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);
    harness.land('p1', { a: { score: 1 } });

    read.getValue({ key: 'p1' });
    const second = depsOf(() => read.getValue({ key: 'p1' }));

    expect(second).toEqual(['read_surface_test_version\u0000p1']);
  });

  it('while the read is disabled, since the thing that will enable it is a write to that partition', () => {
    const harness = makeHarness();
    const read = harness.read({ ...harness.sliceDef, enabled: () => false });
    harness.land('p1', { a: { score: 1 } });

    expect(depsOf(() => read.getValue({ key: 'p1' }))).toEqual(['read_surface_test_version\u0000p1']);
  });

  it('while the partition holds no rows yet, which is exactly when a caller is waiting on the fetch', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);

    expect(depsOf(() => read.getValue({ key: 'cold' }))).toEqual(['read_surface_test_version\u0000cold']);
  });

  it('but registers nothing for a partition that is not addressable', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);

    expect(depsOf(() => read.getValue({ key: '' }))).toEqual([]);
  });

  it('and readMany registers every live partition while skipping the dead ones', () => {
    const harness = makeHarness();
    const read = harness.surface.readMany<{ keys: string[] }, Slice>()({
      partitions: (args: { keys: string[] }) => args.keys,
      select: () => ({}),
      empty: {},
    });

    expect(depsOf(() => read.getValue({ keys: ['p1', '', 'p2'] }))).toEqual(['read_surface_test_version\u0000p1', 'read_surface_test_version\u0000p2']);
  });
});

describe('createReadSurface — the two halves of a read', () => {
  it('serves getValue and useValue from the same select, so an override is the only way they can differ', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);
    harness.land('p1', { a: { score: 1 }, b: { score: 2 } });

    const probe = renderHook(() => read.useValue({ key: 'p1' }));
    expect(read.getValue({ key: 'p1' })).toBe(probe.current.data);
    probe.unmount();
  });

  it('hands back the same envelope across renders, so a consumer can put the result in a dep list', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);
    harness.land('p1', { a: { score: 1 } });

    const probe = renderHook(() => read.useValue({ key: 'p1' }));
    const first = probe.current;
    probe.rerender();

    expect(probe.current).toBe(first);
    expect(probe.current.refetch).toBe(first.refetch);

    harness.land('p1', { a: { score: 2 } });
    expect(probe.current).not.toBe(first);
    probe.unmount();
  });

  it('costs one select per bump no matter how many subscribers share the args', () => {
    const harness = makeHarness();
    const select = jest.fn(harness.sliceDef.select);
    const read = harness.surface.read<{ key: string }, Slice>()({ ...harness.sliceDef, select });
    harness.land('p1', { a: { score: 1 } });

    const probes = [renderHook(() => read.useValue({ key: 'p1' })), renderHook(() => read.useValue({ key: 'p1' }))];
    select.mockClear();
    harness.land('p1', { a: { score: 2 } });

    expect(select).toHaveBeenCalledTimes(1);
    expect(probes[0].current.data).toBe(probes[1].current.data);
    expect(read.getValue({ key: 'p1' })).toBe(probes[0].current.data);
    probes.forEach((probe) => probe.unmount());
  });
});

function makeFieldHarness() {
  const atom = createVersionAtom('read_surface_field_version');
  const slices = new Map<string, Slice>();
  const EMPTY: Slice = {};
  const surface = createReadSurface<{ key: string }>({
    version: atom,
    toParts: (key) => [key.key],
    has: (key) => slices.has(key.key),
  });
  const land = (key: string, slice: Slice) => {
    slices.set(key, slice);
    act(() => {
      atom.bump([key]);
    });
  };
  return { atom, slices, EMPTY, surface, land };
}

describe('createReadSurface — a read declared by field name', () => {
  it('picks the named fields into the key, and varies by the named fields, as the equivalent functions would', () => {
    const harness = makeFieldHarness();
    const read = harness.surface.read<{ key: string; id: string }, Slice>()({
      partition: ['key'],
      varyBy: ['id'],
      select: (args, key) => ({ [args.id]: { score: (harness.slices.get(key.key) ?? {})[args.id]?.score ?? 0 } }),
      empty: harness.EMPTY,
      isEqual: shallowEqualRecord,
    });
    harness.land('nfl', { a: { score: 1 }, b: { score: 2 } });

    expect(read.getValue({ key: 'nfl', id: 'a' })).toEqual({ a: { score: 1 } });
    expect(read.getValue({ key: 'nfl', id: 'b' })).toEqual({ b: { score: 2 } });
    expect(runTracked(() => read.getValue({ key: 'nfl', id: 'a' })).deps.map((dep) => dep.id)).toEqual(['read_surface_field_version\u0000nfl']);
  });

  it('gates on an absent named vary field, exactly as a varyBy function does', () => {
    const harness = makeFieldHarness();
    const read = harness.surface.read<{ key: string; id?: string }, Slice>()({
      partition: ['key'],
      varyBy: ['id'],
      select: () => ({ a: { score: 1 } }),
      empty: harness.EMPTY,
    });
    harness.land('nfl', {});

    expect(read.getValue({ key: 'nfl' })).toBe(harness.EMPTY);
    expect(read.getValue({ key: 'nfl', id: 'a' })).toEqual({ a: { score: 1 } });
  });
});

describe('createReadSurface — varyBy (the read is keyed and gated by one declaration)', () => {
  const scopedRead = (harness: ReturnType<typeof makeHarness>, varyBy: (args: ScopedArgs) => VaryValue[]) =>
    harness.surface.read<ScopedArgs, Slice>()({
      partition: (args) => args.key,
      varyBy,
      select: (args) => ({ a: { score: Number(args.id) } }),
      empty: harness.EMPTY,
      isEqual: shallowEqualRecord,
    });

  it('keys the read by its scope without being told to, so two scopes never share an entry', () => {
    const harness = makeHarness();
    const read = scopedRead(harness, (args) => [args.id]);
    harness.land('nfl', {});

    expect(read.getValue({ key: 'nfl', id: 1 })).toEqual({ a: { score: 1 } });
    expect(read.getValue({ key: 'nfl', id: 2 })).toEqual({ a: { score: 2 } });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['an empty array', []],
  ])('is off while its scope is %s, without an `enabled` clause saying so', (_label, id) => {
    const harness = makeHarness();
    const select = jest.fn(() => ({ a: { score: 1 } }));
    const read = harness.surface.read<ScopedArgs, Slice>()({
      partition: (args) => args.key,
      varyBy: (args: ScopedArgs) => [args.id],
      select,
      empty: harness.EMPTY,
    });
    harness.land('nfl', {});

    const probe = renderHook(() => read.useValue({ key: 'nfl', id }));

    expect(probe.current.data).toBe(harness.EMPTY);
    expect(select).not.toHaveBeenCalled();
    probe.unmount();
  });

  it.each([
    ['zero', 0],
    ['false', false],
  ])('treats %s as present, because it is a value and not an absence', (_label, id) => {
    const harness = makeHarness();
    const read = scopedRead(harness, (args) => [args.id]);
    harness.land('nfl', {});

    expect(read.getValue({ key: 'nfl', id })).toEqual({ a: { score: Number(id) } });
  });

  it('primes the partition even while a scope value is missing, so the row is there when the id arrives', () => {
    const harness = makeHarness();
    const read = scopedRead(harness, (args) => [args.id]);

    const probe = renderHook(() => read.useValue({ key: 'nfl', id: undefined }));

    expect(harness.spies.usePrime[harness.spies.usePrime.length - 1]).toEqual({ key: 'nfl', enabled: true });
    expect(probe.current.data).toBe(harness.EMPTY);
    probe.unmount();
  });
});

describe('createReadSurface — get (imperative)', () => {
  it('self-primes a cold partition and returns empty until it lands', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);

    expect(read.getValue({ key: 'p1' })).toBe(harness.EMPTY);
    expect(harness.spies.ensure).toContain('p1');
  });

  it('leaves a partition that already holds rows alone, so a read is not a refetch', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);
    harness.land('p1', { a: { score: 1 } });

    read.getValue({ key: 'p1' });
    read.getValue({ key: 'p1' });

    expect(harness.spies.ensure).toEqual([]);
  });

  it('is reference-stable per version and recomputes after a bump', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);
    const scoreRow = { score: 1 };
    harness.land('p1', { a: scoreRow });

    const first = read.getValue({ key: 'p1' });
    expect(first).toEqual({ a: scoreRow });
    expect(read.getValue({ key: 'p1' })).toBe(first);

    harness.slices.set('p1', { a: scoreRow });
    act(() => {
      harness.atom.bump(['p1']);
    });
    expect(read.getValue({ key: 'p1' })).toBe(first);

    harness.slices.set('p1', { a: { score: 2 } });
    act(() => {
      harness.atom.bump(['p1']);
    });
    const changed = read.getValue({ key: 'p1' });
    expect(changed).not.toBe(first);
    expect(changed.a.score).toBe(2);
  });

  it('discriminates args that share a partition, so a per-entity read never serves another entity', () => {
    const harness = makeHarness();
    const rows: Record<string, Row> = { p1: { score: 1 }, p2: { score: 2 } };
    const rowRead = harness.surface.read<{ key: string; id: string }, Row | undefined>()({
      partition: (args) => args.key,
      varyBy: (args: { key: string; id: string }) => [args.id],
      select: (args) => rows[args.id],
      empty: undefined,
    });
    harness.land('nfl', {});

    expect(rowRead.getValue({ key: 'nfl', id: 'p1' })).toEqual({ score: 1 });
    expect(rowRead.getValue({ key: 'nfl', id: 'p2' })).toEqual({ score: 2 });

    const first = renderHook(() => rowRead.useValue({ key: 'nfl', id: 'p1' }));
    const second = renderHook(() => rowRead.useValue({ key: 'nfl', id: 'p2' }));
    expect(first.current.data).toEqual({ score: 1 });
    expect(second.current.data).toEqual({ score: 2 });
    first.unmount();
    second.unmount();
  });

  it('returns empty when the read gate is false (never slices)', () => {
    const harness = makeHarness();
    const read = harness.read({ ...harness.sliceDef, enabled: () => false });
    harness.land('p1', { a: { score: 1 } });
    expect(read.getValue({ key: 'p1' })).toBe(harness.EMPTY);
  });

  it('probes presence once per version (has() is memoized, not called per read)', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);
    harness.land('p1', { a: { score: 1 } });

    read.getValue({ key: 'p1' });
    read.getValue({ key: 'p1' });
    read.getValue({ key: 'p1' });
    expect(harness.spies.has).toEqual(['p1']);

    act(() => {
      harness.atom.bump(['p1']);
    });
    read.getValue({ key: 'p1' });
    expect(harness.spies.has).toEqual(['p1', 'p1']);
  });
});

describe('createReadSurface — use (reactive)', () => {
  it('reports loading while cold, then repaints with data when the partition lands', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);
    const probe = renderHook(() => read.useValue({ key: 'p1' }));

    expect(probe.current.isLoading).toBe(true);
    expect(probe.current.status).toBe('loading');
    expect(probe.current.data).toBe(harness.EMPTY);

    harness.land('p1', { a: { score: 1 } });
    expect(probe.current.isLoading).toBe(false);
    expect(probe.current.status).toBe('success');
    expect(probe.current.data).toEqual({ a: { score: 1 } });

    probe.unmount();
  });

  it('bails (no re-render) on a bump that left this read shallow-equal', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);
    const scoreRow = { score: 1 };
    harness.land('p1', { a: scoreRow });

    const probe = renderHook(() => read.useValue({ key: 'p1' }));
    const rendersAfterMount = probe.renders;

    act(() => {
      harness.slices.set('p1', { a: scoreRow });
      harness.atom.bump(['p1']);
    });
    expect(probe.renders).toBe(rendersAfterMount);

    act(() => {
      harness.slices.set('p1', { a: { score: 2 } });
      harness.atom.bump(['p1']);
    });
    expect(probe.current.data.a.score).toBe(2);
    expect(probe.renders).toBe(rendersAfterMount + 1);

    probe.unmount();
  });

  it('disabled: yields empty + success, never subscribes or re-renders on a bump', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);
    const probe = renderHook(() => read.useValue({ key: 'p1' }, { enabled: false }));

    expect(probe.current.data).toBe(harness.EMPTY);
    expect(probe.current.status).toBe('success');
    expect(probe.current.isLoading).toBe(false);
    const rendersAfterMount = probe.renders;

    act(() => {
      harness.atom.bump(['p1']);
    });
    expect(probe.renders).toBe(rendersAfterMount);
    expect(harness.spies.usePrime.every((call) => call.enabled === false)).toBe(true);

    probe.unmount();
  });
});

describe('createReadSurface — presence gating', () => {
  it('never runs select on a cold partition, so a read cannot scan a partition that holds nothing', () => {
    const harness = makeHarness();
    const select = jest.fn(() => harness.EMPTY);
    const slice = harness.read({ ...harness.sliceDef, select });

    const probe = renderHook(() => slice.useValue({ key: 'nfl' }));
    expect(select).not.toHaveBeenCalled();
    expect(slice.getValue({ key: 'nfl' })).toBe(harness.EMPTY);
    expect(select).not.toHaveBeenCalled();

    harness.land('nfl', { p1: { score: 1 } });

    expect(select).toHaveBeenCalled();
    probe.unmount();
  });
});

describe('createReadSurface — a failed fetch', () => {
  it('reports error rather than an empty success, so a screen can tell "broken" from "nothing here"', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);
    harness.fail('p1');

    const probe = renderHook(() => read.useValue({ key: 'p1' }));

    expect(probe.current.status).toBe('error');
    expect(probe.current.isError).toBe(true);
    expect(probe.current.isLoading).toBe(false);
    expect(probe.current.data).toBe(harness.EMPTY);
    probe.unmount();
  });

  it('stays success when rows are already present, so a failed refetch shows stale data instead of an error', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);
    harness.land('p1', { a: { score: 1 } });
    harness.fail('p1');

    const probe = renderHook(() => read.useValue({ key: 'p1' }));

    expect(probe.current.status).toBe('success');
    expect(probe.current.data.a.score).toBe(1);
    probe.unmount();
  });

  it('is success when disabled, so a read gated off never reports someone else\u2019s failure', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);
    harness.fail('p1');

    const probe = renderHook(() => read.useValue({ key: 'p1' }, { enabled: false }));

    expect(probe.current.status).toBe('success');
    probe.unmount();
  });

  it('recovers to success when a retry lands', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);
    harness.fail('p1');
    const probe = renderHook(() => read.useValue({ key: 'p1' }));
    expect(probe.current.status).toBe('error');

    harness.land('p1', { a: { score: 1 } });

    expect(probe.current.status).toBe('success');
    probe.unmount();
  });
});

describe('createReadSurface — absent args (nothing to read yet)', () => {
  it('yields empty + success without touching the definition, so a caller needs no stand-in partition', () => {
    const harness = makeHarness();
    const partition = jest.fn((args: { key: string }) => args.key);
    const varyBy = jest.fn((args: { key: string }) => [args.key]);
    const select = jest.fn(harness.sliceDef.select);
    const read = harness.surface.read<{ key: string }, Slice>()({ ...harness.sliceDef, partition, varyBy, select });

    const probe = renderHook(() => read.useValue(undefined));

    expect(probe.current.data).toBe(harness.EMPTY);
    expect(probe.current.status).toBe('success');
    expect(probe.current.isLoading).toBe(false);
    expect(partition).not.toHaveBeenCalled();
    expect(varyBy).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    probe.unmount();
  });

  it('does not prime, so a read with no args cannot fetch a partition that does not exist', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);

    const probe = renderHook(() => read.useValue(undefined));

    expect(harness.spies.usePrime.every((call) => call.enabled === false)).toBe(true);
    probe.unmount();
  });

  it('never consults the custom enabled gate, which is written expecting real args', () => {
    const harness = makeHarness();
    const enabled = jest.fn(() => true);
    const read = harness.read({ ...harness.sliceDef, enabled });

    const probe = renderHook(() => read.useValue(undefined));

    expect(enabled).not.toHaveBeenCalled();
    expect(probe.current.status).toBe('success');
    probe.unmount();
  });

  it('keeps hook order stable across args appearing, so a screen can mount before its id resolves', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);
    harness.land('p1', { a: { score: 1 } });

    let seen: Slice = harness.EMPTY;
    const Component = ({ args }: { args?: { key: string } }) => {
      seen = read.useValue(args).data;
      return null;
    };

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(Component, {}));
    });
    expect(seen).toBe(harness.EMPTY);

    // Updates the same component instance, so the hook keeps its identity across the change of args.
    act(() => {
      renderer.update(React.createElement(Component, { args: { key: 'p1' } }));
    });
    expect(seen).toEqual({ a: { score: 1 } });

    act(() => {
      renderer.unmount();
    });
  });

  it('reads as empty imperatively too, so a callback with no args is not a crash', () => {
    const harness = makeHarness();
    const read = harness.read(harness.sliceDef);
    harness.land('p1', { a: { score: 1 } });

    expect(read.getValue(undefined)).toBe(harness.EMPTY);
    expect(harness.spies.ensure).toEqual([]);
  });

  it('applies to readMany as well, spanning no partitions at all', () => {
    const harness = makeHarness();
    const EMPTY_LIST: Slice[] = [];
    const partitions = jest.fn((args: { keys: string[] }) => args.keys);
    const list = harness.surface.readMany<{ keys: string[] }, Slice[]>()({
      partitions,
      select: (_args, keys) => keys.map((key) => harness.slices.get(key) ?? harness.EMPTY),
      empty: EMPTY_LIST,
    });

    const probe = renderHook(() => list.useValue(undefined));

    expect(probe.current.data).toBe(EMPTY_LIST);
    expect(probe.current.status).toBe('success');
    expect(partitions).not.toHaveBeenCalled();
    expect(list.getValue(undefined)).toBe(EMPTY_LIST);
    probe.unmount();
  });
});

describe('createReadSurface — readMany (a read spanning a variable partition set)', () => {
  const manyHarness = () => {
    const harness = makeHarness();
    const EMPTY_LIST: Slice[] = [];
    const list = createReadSurface(harness.kernel).readMany<{ keys: string[] }, Slice[]>()({
      partitions: (args) => args.keys,
      varyBy: (args: { keys: string[] }) => [args.keys],
      select: (_args, keys) => keys.map((key) => harness.slices.get(key) ?? harness.EMPTY),
      empty: EMPTY_LIST,
    });
    return { ...harness, list, EMPTY_LIST };
  };

  it('re-reads when any one of its partitions is written, not just the first', () => {
    const harness = manyHarness();
    harness.land('a', { p1: { score: 1 } });
    harness.land('b', { p2: { score: 2 } });
    const probe = renderHook(() => harness.list.useValue({ keys: ['a', 'b'] }));
    expect(probe.current.data.map((slice) => Object.keys(slice))).toEqual([['p1'], ['p2']]);

    harness.land('b', { p2: { score: 9 } });

    expect(probe.current.data[1].p2.score).toBe(9);
    probe.unmount();
  });

  it('primes every partition it spans, so a set with one cold entry still fetches that entry', () => {
    const harness = manyHarness();
    harness.land('a', { p1: { score: 1 } });
    const probe = renderHook(() => harness.list.useValue({ keys: ['a', 'cold'] }));

    expect(harness.spies.usePrimeMany[harness.spies.usePrimeMany.length - 1]).toEqual({ keys: ['a', 'cold'], enabled: true });
    probe.unmount();
  });

  it('primes imperatively too, so a getValue on a cold set still fetches it', () => {
    const harness = manyHarness();
    harness.list.getValue({ keys: ['a', 'cold'] });

    expect(harness.spies.ensure).toEqual(expect.arrayContaining(['a', 'cold']));
  });

  it('reports loading while the whole set is cold, rather than a premature empty success', () => {
    const harness = manyHarness();
    const probe = renderHook(() => harness.list.useValue({ keys: ['a', 'b'] }));
    expect(probe.current.status).toBe('loading');

    harness.land('a', { p1: { score: 1 } });
    harness.land('b', { p2: { score: 2 } });

    expect(probe.current.status).toBe('success');
    expect(probe.current.isFetching).toBe(false);
    probe.unmount();
  });

  it('reports success once any partition can be rendered, but keeps isFetching while the rest land', () => {
    const harness = manyHarness();
    harness.land('a', { p1: { score: 1 } });
    const probe = renderHook(() => harness.list.useValue({ keys: ['a', 'cold'] }));

    expect(probe.current.status).toBe('success');
    expect(probe.current.isFetching).toBe(true);
    probe.unmount();
  });

  it('serves getValue and useValue from the same select, so the imperative half cannot drift', () => {
    const harness = manyHarness();
    harness.land('a', { p1: { score: 1 } });
    harness.land('b', { p2: { score: 2 } });
    const probe = renderHook(() => harness.list.useValue({ keys: ['a', 'b'] }));

    expect(harness.list.getValue({ keys: ['a', 'b'] })).toEqual(probe.current.data);
    probe.unmount();
  });

  it('keys on the whole partition set, so a different set is not served the previous one', () => {
    const harness = manyHarness();
    harness.land('a', { p1: { score: 1 } });
    harness.land('b', { p2: { score: 2 } });

    expect(harness.list.getValue({ keys: ['a'] }).map((slice) => Object.keys(slice))).toEqual([['p1']]);
    expect(harness.list.getValue({ keys: ['a', 'b'] }).map((slice) => Object.keys(slice))).toEqual([['p1'], ['p2']]);
  });

  it('errors only when the whole set failed, so one bad partition degrades to a gap', () => {
    const harness = manyHarness();
    harness.fail('a');
    harness.fail('b');
    const allFailed = renderHook(() => harness.list.useValue({ keys: ['a', 'b'] }));
    expect(allFailed.current.status).toBe('error');
    allFailed.unmount();

    harness.land('a', { p1: { score: 1 } });
    const oneFailed = renderHook(() => harness.list.useValue({ keys: ['a', 'b'] }));
    expect(oneFailed.current.status).toBe('success');
    oneFailed.unmount();
  });

  it('publishes the fields it declares it requires, since its partitions come from a function with none to read', () => {
    const harness = manyHarness();
    const EMPTY_LIST: Slice[] = [];
    const gated = harness.surface.readMany<{ keys: string[] }, Slice[]>()({
      requires: ['keys'],
      partitions: (args) => args.keys,
      select: (_args, keys) => keys.map((key) => harness.slices.get(key) ?? harness.EMPTY),
      empty: EMPTY_LIST,
    });

    expect(gated.requires).toEqual(['keys']);
    expect(harness.list.requires).toBeUndefined();
  });

  it('primes a set it is not yet reading, since a disabled read still wants its data on the way', () => {
    const harness = makeHarness();
    const EMPTY_LIST: Slice[] = [];
    const list = harness.surface.readMany<{ keys: string[]; reading: boolean }, Slice[]>()({
      partitions: (args) => args.keys,
      enabled: (args) => args.reading,
      varyBy: (args: { keys: string[] }) => [args.keys],
      select: (_args, keys) => keys.map((key) => harness.slices.get(key) ?? harness.EMPTY),
      empty: EMPTY_LIST,
    });

    const probe = renderHook(() => list.useValue({ keys: ['a', 'b'], reading: false }));

    expect(harness.spies.usePrimeMany[harness.spies.usePrimeMany.length - 1]).toEqual({ keys: ['a', 'b'], enabled: true });
    expect(probe.current.data).toBe(EMPTY_LIST);
    probe.unmount();
  });
});

describe('createReadSurface — a push-fed store, which has no fetch to own', () => {
  const pushHarness = () => {
    const atom = createVersionAtom('read_surface_push_test');
    const slices = new Map<string, Slice>();
    const EMPTY: Slice = {};
    const surface = createReadSurface<{ key: string }>({ version: atom, toParts: (key) => [key.key], has: (key) => slices.has(key.key) });
    const slice = surface.read<{ key: string }, Slice>()({
      partition: ['key'],
      select: (_args, key) => slices.get(key.key) ?? EMPTY,
      empty: EMPTY,
      isEqual: shallowEqualRecord,
    });
    return { atom, slices, slice, EMPTY };
  };

  it('reports success rather than loading while empty, since nothing is coming to fill it', () => {
    const harness = pushHarness();
    const probe = renderHook(() => harness.slice.useValue({ key: 'nfl' }));

    expect(probe.current.data).toBe(harness.EMPTY);
    expect(probe.current.status).toBe('success');
    expect(probe.current.isLoading).toBe(false);

    probe.unmount();
  });

  it('still serves a pushed row, so omitting the fetch hooks costs no reactivity', () => {
    const harness = pushHarness();
    const probe = renderHook(() => harness.slice.useValue({ key: 'nfl' }));

    act(() => {
      harness.slices.set('nfl', { p1: { score: 3 } });
      harness.atom.bump(['nfl']);
    });

    expect(probe.current.data.p1.score).toBe(3);
    expect(harness.slice.getValue({ key: 'nfl' })).toBe(probe.current.data);
    probe.unmount();
  });
});

describe('createReadSurface — the presence probe is shared across a surface reads', () => {
  it('probes a partition once for the surface, however many reads address it', () => {
    const harness = makeHarness();
    const first = harness.read(harness.sliceDef);
    const second = harness.read(harness.sliceDef);
    const third = harness.read(harness.sliceDef);
    harness.land('p1', { a: { score: 1 } });
    harness.spies.has.length = 0;

    first.getValue({ key: 'p1' });
    second.getValue({ key: 'p1' });
    third.getValue({ key: 'p1' });

    expect(harness.spies.has).toEqual(['p1']);
  });

  it('keeps partitions apart, so sharing the cache does not answer for the wrong one', () => {
    const harness = makeHarness();
    const first = harness.read(harness.sliceDef);
    const second = harness.read(harness.sliceDef);
    harness.land('p1', { a: { score: 1 } });
    harness.land('p2', { b: { score: 2 } });
    harness.spies.has.length = 0;

    first.getValue({ key: 'p1' });
    second.getValue({ key: 'p2' });

    expect(harness.spies.has).toEqual(['p1', 'p2']);
  });

  it('re-probes after a write, since that is the one thing that can flip presence', () => {
    const harness = makeHarness();
    const first = harness.read(harness.sliceDef);
    const second = harness.read(harness.sliceDef);

    first.getValue({ key: 'p1' });
    harness.spies.has.length = 0;

    harness.land('p1', { a: { score: 1 } });
    first.getValue({ key: 'p1' });
    second.getValue({ key: 'p1' });

    expect(harness.spies.has).toEqual(['p1']);
    expect(second.getValue({ key: 'p1' })).toEqual({ a: { score: 1 } });
  });
});
