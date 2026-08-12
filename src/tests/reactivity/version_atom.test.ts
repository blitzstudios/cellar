import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { createVersionAtom } from '../../reactivity/version_atom';
import { runTracked } from '../../reactivity/tracking';

/* global globalThis */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Probe<T> = { current: T; renders: number; unmount: () => void };

function renderHook<T>(useHook: () => T): Probe<T> {
  const probe: Probe<T> = { current: undefined as unknown as T, renders: 0, unmount: () => {} };
  const Component = () => {
    probe.current = useHook();
    probe.renders += 1;
    return null;
  };
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Component));
  });
  probe.unmount = () =>
    act(() => {
      renderer.unmount();
    });
  return probe;
}

const NFL = ['nfl', '2024', 'regular', '5'];
const NBA = ['nba', '2025', 'regular', 'g_1815'];

describe('createVersionAtom — imperative surface', () => {
  it('reads 0 until written, then reflects bumps', () => {
    const atom = createVersionAtom('test_store_version');
    expect(atom.get(NFL)).toBe(0);
    expect(atom.bump(NFL)).toBe(1);
    expect(atom.bump(NFL)).toBe(2);
    expect(atom.get(NFL)).toBe(2);
    expect(atom.get(NBA)).toBe(0);
  });

  it('namespaces key by root', () => {
    const atom = createVersionAtom('test_store_version');
    expect(atom.key(['a', 'b'])).toEqual(['test_store_version', 'a\u0000b']);
  });

  it('keeps part lists distinct when a part contains the separator character used elsewhere', () => {
    const atom = createVersionAtom('test_store_version');
    atom.bump(['clubsoccer:epl', 'x']);
    expect(atom.get(['clubsoccer', 'epl:x'])).toBe(0);
    expect(atom.get(['clubsoccer:epl', 'x'])).toBe(1);
  });

  it('retains a written version across unsubscribe, so a cached value stamped with it cannot read as current', () => {
    const atom = createVersionAtom('test_store_version');
    const unsub = atom.subscribe(NFL, () => {});
    atom.bump(NFL);
    expect(atom.get(NFL)).toBe(1);

    unsub();
    expect(atom.get(NFL)).toBe(1);
    expect(atom.bump(NFL)).toBe(2);
  });

  it('subscribe fires on a bump to its partition and stops after unsubscribe', () => {
    const atom = createVersionAtom('test_store_version');
    const listener = jest.fn();
    const unsub = atom.subscribe(NFL, listener);

    atom.bump(NFL);
    expect(listener).toHaveBeenCalledTimes(1);
    atom.bump(NBA);
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    atom.bump(NFL);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('records a dependency via runTracked when get() runs inside a tracking scope', () => {
    const atom = createVersionAtom('test_store_version');
    const { deps } = runTracked(() => atom.get(NFL));
    expect(deps).toHaveLength(1);
    const listener = jest.fn();
    deps[0].subscribe(listener);
    atom.bump(NFL);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('createVersionAtom — reactive hooks', () => {
  it('useVersion re-reads on a bump to its partition and ignores unrelated bumps', () => {
    const atom = createVersionAtom('test_store_version');
    const probe = renderHook(() => atom.useVersion(NFL));
    expect(probe.current).toBe(0);

    act(() => {
      atom.bump(NFL);
    });
    expect(probe.current).toBe(1);

    const rendersBefore = probe.renders;
    act(() => {
      atom.bump(NBA);
    });
    expect(probe.current).toBe(1);
    expect(probe.renders).toBe(rendersBefore);

    probe.unmount();
  });

  it('shares one entry across subscribers — a single bump updates all', () => {
    const atom = createVersionAtom('test_store_version');
    const first = renderHook(() => atom.useVersion(NFL));
    const second = renderHook(() => atom.useVersion(NFL));

    act(() => {
      atom.bump(NFL);
    });
    expect(first.current).toBe(1);
    expect(second.current).toBe(1);

    first.unmount();
    second.unmount();
  });

  it('useVersion stays 0 and unsubscribed when a partition part is falsy (disabled)', () => {
    const atom = createVersionAtom('test_store_version');
    const disabled = ['nfl', '', 'regular', '5'];
    const probe = renderHook(() => atom.useVersion(disabled));
    expect(probe.current).toBe(0);

    act(() => {
      atom.bump(disabled);
    });
    expect(probe.current).toBe(0);

    probe.unmount();
  });
});

describe('createVersionAtom — useSelect value bail-out', () => {
  it('re-renders only when the selected value changes, not on every partition bump', () => {
    const atom = createVersionAtom('test_store_version');
    const rows = new Map<string, { id: string; score: number }>();
    rows.set('me', { id: 'me', score: 10 });
    const readMine = () => rows.get('me');

    const probe = renderHook(() => atom.useSelect(NFL, true, ['me'], readMine, Object.is, undefined));
    expect(probe.current?.score).toBe(10);
    const rendersAfterMount = probe.renders;

    act(() => {
      rows.set('other', { id: 'other', score: 99 });
      atom.bump(NFL);
    });
    expect(probe.current?.score).toBe(10);
    expect(probe.renders).toBe(rendersAfterMount);

    act(() => {
      rows.set('me', { id: 'me', score: 20 });
      atom.bump(NFL);
    });
    expect(probe.current?.score).toBe(20);
    expect(probe.renders).toBe(rendersAfterMount + 1);

    probe.unmount();
  });

  it('useSelectMany bails when a shallow-equal map is returned across a bump', () => {
    const atom = createVersionAtom('test_store_version');
    const entryA = { id: 'a' };
    const entryB = { id: 'b' };
    let map: Record<string, { id: string }> = { a: entryA, b: entryB };
    const read = () => map;
    const shallow = (left: Record<string, { id: string }>, right: Record<string, { id: string }>): boolean => {
      const leftKeys = Object.keys(left);
      if (leftKeys.length !== Object.keys(right).length) return false;
      return leftKeys.every((key) => Object.is(left[key], right[key]));
    };

    const probe = renderHook(() => atom.useSelectMany([NFL, NBA], true, ['ab'], read, shallow, {}));
    const rendersAfterMount = probe.renders;

    act(() => {
      map = { a: entryA, b: entryB };
      atom.bump(NFL);
    });
    expect(probe.renders).toBe(rendersAfterMount);

    act(() => {
      map = { a: entryA, b: { id: 'b2' } };
      atom.bump(NBA);
    });
    expect(probe.current.b.id).toBe('b2');
    expect(probe.renders).toBe(rendersAfterMount + 1);

    probe.unmount();
  });
});
