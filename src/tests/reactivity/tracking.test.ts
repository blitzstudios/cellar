import { createVersionAtom } from '../../reactivity/version_atom';
import { createVersionedCache } from '../../caches';
import { isTracking, runTracked, trackDependency } from '../../reactivity/tracking';

const NFL = ['nfl', '2024', 'regular', '5'];
const NBA = ['nba', '2025', 'regular', 'g_1815'];

describe('runTracked / trackDependency', () => {
  it('collects a version atom read as a dependency, deduped per partition', () => {
    const atom = createVersionAtom('track_test_a');
    const { value, deps } = runTracked(() => {
      atom.get(NFL);
      atom.get(NFL);
      atom.get(NBA);
      return 42;
    });
    expect(value).toBe(42);
    expect(deps).toHaveLength(2);
    expect(deps.map((dep) => dep.id).sort()).toEqual([
      'track_test_a\u0000nba\u00002025\u0000regular\u0000g_1815',
      'track_test_a\u0000nfl\u00002024\u0000regular\u00005',
    ]);
  });

  it('records a dependency whose subscribe fires on a bump to that partition', () => {
    const atom = createVersionAtom('track_test_b');
    const { deps } = runTracked(() => atom.get(NFL));
    const dep = deps[0];
    expect(dep.getVersion()).toBe(0);

    const listener = jest.fn();
    const unsub = dep.subscribe(listener);
    atom.bump(NFL);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(dep.getVersion()).toBe(1);

    atom.bump(NBA);
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    atom.bump(NFL);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('records nothing (and reports no active scope) outside runTracked', () => {
    const atom = createVersionAtom('track_test_c');
    expect(isTracking()).toBe(false);
    atom.get(NFL);
    expect(() => trackDependency({ id: 'x', subscribe: () => () => {}, getVersion: () => 0 })).not.toThrow();
  });

  it('isolates nested scopes — the inner run does not leak into the outer', () => {
    const atom = createVersionAtom('track_test_d');
    let innerDeps: string[] = [];
    const { deps: outerDeps } = runTracked(() => {
      atom.get(NFL);
      const inner = runTracked(() => atom.get(NBA));
      innerDeps = inner.deps.map((dep) => dep.id);
      return null;
    });
    expect(innerDeps).toEqual(['track_test_d\u0000nba\u00002025\u0000regular\u0000g_1815']);
    expect(outerDeps.map((dep) => dep.id)).toEqual(['track_test_d\u0000nfl\u00002024\u0000regular\u00005']);
  });

  it('restores the previous scope even when fn throws', () => {
    const atom = createVersionAtom('track_test_e');
    expect(() =>
      runTracked(() => {
        atom.get(NFL);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(isTracking()).toBe(false);
  });

  it('a versioned-cache HIT still records the partition dependency', () => {
    const atom = createVersionAtom('track_test_memo');
    const compute = jest.fn(() => 'value');
    const cache = createVersionedCache<string>(16);

    const read = () => cache.read('player:1', atom.get(NFL), compute);

    const first = runTracked(read);
    expect(first.value).toBe('value');
    expect(first.deps.map((dep) => dep.id)).toEqual(['track_test_memo\u0000nfl\u00002024\u0000regular\u00005']);

    const second = runTracked(read);
    expect(second.value).toBe('value');
    expect(compute).toHaveBeenCalledTimes(1);
    expect(second.deps.map((dep) => dep.id)).toEqual(['track_test_memo\u0000nfl\u00002024\u0000regular\u00005']);
  });
});
