/** The per-partition version counter that stands in for change notification: a write bumps it, a reader watches it. */

import { DependencyList, useCallback, useMemo } from 'react';
import { useSyncExternalStore } from 'use-sync-external-store/shim';
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector';

import { cacheKey, GROUP_SEP, partitionsKey } from '../args_key';
import { getOrCreate } from '../collections';
import { Dep, runSubscribed, trackDependency } from './tracking';

/** Whether a part list addresses a real partition: at least one part, and every part filled in. */
export const isLive = (parts: readonly string[]): boolean => parts.length > 0 && parts.every(Boolean);

/** Stable empty part list, for a hook that must run in the same position while addressing nothing. */
export const NO_PARTS: readonly string[] = Object.freeze([]);

/** A partition key paired with the parts it is keyed by, for a caller needing both over a set of them — a presence probe across a `readMany`. */
export interface PartitionEntry<Key> {
  key: Key;
  parts: readonly string[];
}

/** Each key paired with its parts, gaps included, so the result stays parallel with the keys named. */
export function partitionEntries<Key>(keys: readonly Key[], toParts: (key: Key) => readonly string[]): PartitionEntry<Key>[] {
  return keys.map((key) => ({ key, parts: toParts(key) }));
}

/**
 * The change notification for a whole store, one integer per partition: a write bumps, a reactive reader subscribes
 * through `useVersion` / `useSelect`, and `get` reads imperatively while registering the partition with any active
 * tracking scope. A store is handed one by its spine and passes it to `definePartitions`.
 */
export interface VersionAtom {
  key(parts: readonly string[]): [string, string];
  /** 0 for a partition that has never been written. */
  get(parts: readonly string[]): number;
  bump(parts: readonly string[]): number;
  bumpAll(): void;
  subscribe(parts: readonly string[], listener: () => void): () => void;
  useVersion(parts: readonly string[], enabled?: boolean): number;
  useSelect<T>(parts: readonly string[], enabled: boolean, deps: DependencyList, compute: () => T, isEqual: (left: T, right: T) => boolean, empty: T): T;
  useSelectMany<T>(
    partsList: readonly (readonly string[])[],
    enabled: boolean,
    deps: DependencyList,
    compute: () => T,
    isEqual: (left: T, right: T) => boolean,
    empty: T,
  ): T;
}

type VersionEntry = { value: number; listeners: Set<() => void> };

/**
 * Builds the atom for one store, `root` naming it in the dependency ids its reads report. Its entries are module-level
 * and one per partition, so a write wakes every reader of that partition and no reader of any other.
 */
export function createVersionAtom(root: string): VersionAtom {
  const specifier = (parts: readonly string[]): string => cacheKey(...parts);
  const key = (parts: readonly string[]): [string, string] => [root, specifier(parts)];

  const entries = new Map<string, VersionEntry>();
  const ensure = (spec: string): VersionEntry => getOrCreate(entries, spec, () => ({ value: 0, listeners: new Set() }));

  const getSpec = (spec: string): number => entries.get(spec)?.value ?? 0;

  /**
   * One descriptor per partition rather than one per read. `root` is fixed for the atom and the closures capture
   * nothing but `spec`, so what `get` used to build every call -- an id string, an object and two closures -- was
   * identical each time, and `get` runs once per partition per read. {@link trackDependency} dedupes by `id` and
   * only ever reads the descriptor, so one shared instance behaves the same as a fresh one.
   *
   * Held apart from `entries` because `get` deliberately does not create an entry: seeding one per read would widen
   * what `bumpAll` bumps. Its keys are partitions, the same space `entries` occupies.
   */
  const deps = new Map<string, Dep>();
  const depFor = (spec: string): Dep =>
    getOrCreate(deps, spec, () => ({
      id: cacheKey(root, spec),
      subscribe: (listener: () => void) => subscribeSpec(spec, listener),
      getVersion: () => getSpec(spec),
    }));

  const get = (parts: readonly string[]): number => {
    const spec = specifier(parts);
    trackDependency(depFor(spec));
    return getSpec(spec);
  };

  const bumpSpec = (spec: string): number => {
    const entry = ensure(spec);
    entry.value += 1;
    // Synchronous fan-out; ingest bumps inside `notifyManager.batch` so the re-renders coalesce.
    entry.listeners.forEach((listener) => listener());
    return entry.value;
  };
  const bump = (parts: readonly string[]): number => bumpSpec(specifier(parts));

  // Snapshotted first: a listener may write, and writing bumps, which mutates the map mid-walk.
  const bumpAll = (): void => Array.from(entries.keys()).forEach(bumpSpec);

  const subscribeSpec = (spec: string, listener: () => void): (() => void) => {
    const entry = ensure(spec);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      // A written entry must stay: dropping it resets `get` to 0, and a value cached with version 0 reads as current.
      if (entry.listeners.size === 0 && entry.value === 0 && entries.get(spec) === entry) {
        entries.delete(spec);
        // Follows the entry rather than outliving it. A descriptor already handed to a sink keeps working -- it
        // reads `entries` through `spec` on each call -- and the next read rebuilds an identical one.
        deps.delete(spec);
      }
    };
  };

  const useVersion = (parts: readonly string[], enabled?: boolean): number => {
    const spec = specifier(parts);
    const isEnabled = (enabled ?? true) && isLive(parts);
    const subscribe = useCallback((onChange: () => void) => (isEnabled ? subscribeSpec(spec, onChange) : () => {}), [spec, isEnabled]);
    const getSnapshot = useCallback(() => (isEnabled ? getSpec(spec) : 0), [spec, isEnabled]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  };

  /** The subscribe-and-select engine behind both hooks. `activeKey` is the stable identity of `specs`. */
  function useSpecsSelect<T>(
    specs: readonly string[],
    activeKey: string,
    enabled: boolean,
    deps: DependencyList,
    compute: () => T,
    isEqual: (left: T, right: T) => boolean,
    empty: T,
  ): T {
    const subscribe = useCallback(
      (onChange: () => void) => {
        if (!enabled) return () => {};
        const unsubs = specs.map((spec) => subscribeSpec(spec, onChange));
        return () => unsubs.forEach((unsub) => unsub());
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps -- activeKey is the stable identity of `specs`
      [activeKey, enabled],
    );
    const getVersionSnapshot = useCallback(
      () => {
        if (!enabled) return 0;
        let sum = 0;
        for (const spec of specs) sum += getSpec(spec);
        return sum;
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps -- activeKey is the stable identity of `specs`
      [activeKey, enabled],
    );
    // `subscribe` above covers whatever `compute` reads, which is what the render-phase guard checks for.
    const selector = useCallback(
      () => (enabled ? runSubscribed(compute) : empty),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the read-arg identity; `compute`/`empty` are stable per call site.
      [enabled, ...deps],
    );
    return useSyncExternalStoreWithSelector(subscribe, getVersionSnapshot, getVersionSnapshot, selector, isEqual);
  }

  const useSelect = <T>(
    parts: readonly string[],
    enabled: boolean,
    deps: DependencyList,
    compute: () => T,
    isEqual: (left: T, right: T) => boolean,
    empty: T,
  ): T => {
    const spec = specifier(parts);
    const specs = useMemo(() => [spec], [spec]);
    return useSpecsSelect(specs, spec, enabled, deps, compute, isEqual, empty);
  };

  const useSelectMany = <T>(
    partsList: readonly (readonly string[])[],
    enabled: boolean,
    deps: DependencyList,
    compute: () => T,
    isEqual: (left: T, right: T) => boolean,
    empty: T,
  ): T => {
    const specsKey = partitionsKey(partsList);
    const specs = useMemo(
      () => partsList.filter(isLive).map((parts) => specifier(parts)),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- specsKey is the stable identity of the partition set
      [specsKey],
    );
    return useSpecsSelect(specs, specs.join(GROUP_SEP), enabled, deps, compute, isEqual, empty);
  };

  const subscribe = (parts: readonly string[], listener: () => void): (() => void) => subscribeSpec(specifier(parts), listener);

  return { key, get, bump, bumpAll, subscribe, useVersion, useSelect, useSelectMany };
}
