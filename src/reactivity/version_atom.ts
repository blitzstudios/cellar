/** The per-partition version counter that stands in for change notification: a write bumps it, a reader watches it. */

import { DependencyList, useCallback, useMemo, useRef } from 'react';
import { useSyncExternalStore } from 'use-sync-external-store/shim';
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector';

import { cacheKey, GROUP_SEP, partitionsKey } from '../args_key';
import { getOrCreate } from '../collections';
import { readGateRuntime } from '../runtime';
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

  const sumOf = (specs: readonly string[]): number => {
    let sum = 0;
    for (const spec of specs) sum += getSpec(spec);
    return sum;
  };

  /**
   * The host's read gate, applied to a subscription. While the gate is dead the subscription is dropped and the
   * version is HELD at what it was when the gate closed, so a read keeps showing the value it already had rather
   * than repainting with data nobody is looking at. When the gate goes live the subscription is restored and, only
   * if the version moved meanwhile, one notification is sent so the reader catches up in a single render.
   *
   * Holding the VERSION rather than the value is what makes this nearly free: both hooks below feed the version to
   * `useSyncExternalStore*`, and the selector variant memoizes on that snapshot, so an unchanged version means the
   * selector never re-runs and the prior value comes back by reference.
   *
   * Why the subscription and not the render: a read that returned `empty` while gated would blank the screen, and a
   * read that re-rendered when the gate moved would wake every screen in the stack on each navigation. Gating here
   * leaves the gate invisible to the render.
   */
  function useHeldVersion(specs: readonly string[], activeKey: string, enabled: boolean) {
    const gate = readGateRuntime().useReadGate();
    // Non-null exactly while held. Written from the subscription below, never from `getSnapshot`, which stays pure.
    const held = useRef<number | null>(null);

    const subscribe = useCallback(
      (onChange: () => void) => {
        if (!enabled) return () => {};
        let unsubs: (() => void)[] | null = null;
        const attach = () => {
          if (!unsubs) unsubs = specs.map((spec) => subscribeSpec(spec, onChange));
        };
        const detach = () => {
          unsubs?.forEach((unsub) => unsub());
          unsubs = null;
        };
        const sync = (announce: boolean) => {
          if (gate.isLive()) {
            const wasHeld = held.current;
            held.current = null;
            attach();
            // Nothing moved while away, so there is nothing to catch up on and no render to spend.
            if (announce && wasHeld !== null && wasHeld !== sumOf(specs)) onChange();
          } else {
            // Captured as the gate closes, so a bump arriving later cannot move what a held read shows.
            held.current = sumOf(specs);
            detach();
          }
        };
        sync(false);
        const offGate = gate.onChange(() => sync(true));
        return () => {
          detach();
          offGate();
          held.current = null;
        };
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps -- activeKey is the stable identity of `specs`
      [activeKey, enabled, gate],
    );

    const getSnapshot = useCallback(
      () => {
        if (!enabled) return 0;
        const version = held.current;
        return version !== null ? version : sumOf(specs);
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps -- activeKey is the stable identity of `specs`; the gate arrives through the ref
      [activeKey, enabled],
    );

    return { subscribe, getSnapshot };
  }

  const useVersion = (parts: readonly string[], enabled?: boolean): number => {
    const spec = specifier(parts);
    const isEnabled = (enabled ?? true) && isLive(parts);
    const specs = useMemo(() => [spec], [spec]);
    const { subscribe, getSnapshot } = useHeldVersion(specs, spec, isEnabled);
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
    const { subscribe, getSnapshot: getVersionSnapshot } = useHeldVersion(specs, activeKey, enabled);
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
