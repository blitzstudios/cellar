/**
 * A {@link VersionAtom} for tests: real `subscribe` and `bump`, hooks that recompute on every call, and a `bumped`
 * log naming every partition bumped, in order.
 */

import { VersionAtom } from '../reactivity/version_atom';

export function createTestVersionAtom(): VersionAtom & { bumped: string[] } {
  const versions = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();
  const bumped: string[] = [];
  const spec = (parts: readonly string[]): string => parts.join(':');

  const bumpSpec = (key: string): number => {
    const next = (versions.get(key) ?? 0) + 1;
    versions.set(key, next);
    bumped.push(key);
    listeners.get(key)?.forEach((listener) => listener());
    return next;
  };

  const atom: VersionAtom = {
    key: (parts) => ['v', spec(parts)],
    get: (parts) => versions.get(spec(parts)) ?? 0,
    bump: (parts) => bumpSpec(spec(parts)),
    bumpAll: () => [...new Set([...versions.keys(), ...listeners.keys()])].forEach(bumpSpec),
    subscribe: (parts, listener) => {
      const key = spec(parts);
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
        if (set && set.size === 0) listeners.delete(key);
      };
    },
    useVersion: (parts) => versions.get(spec(parts)) ?? 0,
    useSelect: (_parts, enabled, _deps, compute, _isEqual, empty) => (enabled ? compute() : empty),
    useSelectMany: (_partsList, enabled, _deps, compute, _isEqual, empty) => (enabled ? compute() : empty),
  };

  return Object.assign(atom, { bumped });
}
