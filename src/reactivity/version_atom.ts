/**
 * The version atom: how a store's reads learn about its writes. It keeps a version number for each partition (the set
 * of rows one fetch returns and replaces), and the version at which each unit in it last changed (a unit is all the
 * rows sharing one value of the table's unit column, such as one player's rows).
 *
 * A write "bumps" the partition with the units it changed, which raises the numbers and notifies whoever is listening
 * to them. A read records which numbers it looked at, and re-runs when one of them moves: a read of named units only
 * when those units change, a read of the whole partition on any change.
 */

import { useCallback, useRef } from 'react';
import { useSyncExternalStore } from 'use-sync-external-store/shim';

import { cacheKey, GROUP_SEP, cacheKeyOf } from '../args_key';
import { getOrCreate } from '../collections';
import { readGateRuntime } from '../runtime';
import { Dep, trackDependency } from './tracking';
import { ALL_UNITS, ChangeSet, isUnchanged } from '../table/change_set';

/**
 * Whether a partition key's parts name an actual partition: at least one part, and none of them empty. A key built from
 * args that are still missing a value has an empty part, and reads and fetches nothing.
 */
export const addressesPartition = (parts: readonly string[]): boolean => parts.length > 0 && parts.every(Boolean);

/** An empty, shared list of key parts, for a hook that must still run while its args name no partition yet. */
export const NO_PARTS: readonly string[] = Object.freeze([]);

/** A partition's key together with its key parts (the key's values as a list of strings). */
export interface PartitionEntry<Key> {
  /** The partition's key, as the store defines it. */
  key: Key;
  /** The key's values as a list of strings, which identify the partition in the version atom and in query keys. */
  parts: readonly string[];
}

/**
 * Pairs each partition key with its key parts, in the same order. Keys that name no partition (from args still missing
 * a value) are kept, so positions still line up with the list of keys.
 */
export function partitionEntries<Key>(keys: readonly Key[], toParts: (key: Key) => readonly string[]): PartitionEntry<Key>[] {
  return keys.map((key) => ({ key, parts: toParts(key) }));
}

/**
 * A store's version numbers: how its reads learn about its writes. Every method takes a partition's key parts (the
 * partition key's values as a list of strings). A partition is the set of rows one fetch returns and replaces; a unit
 * is all the rows sharing one value of the table's unit column, such as one player's rows.
 *
 * Each partition has three numbers, and reading one inside a tracking scope (a `useValue` read, `useTrackedStores`, a
 * tracked selector) makes the scope depend on it, so the scope re-runs when it changes:
 *
 * - `get`: the partition's version, which goes up on every write that changes anything in it. A read of the whole
 *   partition depends on this.
 * - `getUnit`: the version at which one unit last changed. A read of particular units depends on just those, so a
 *   write to other units doesn't re-run it.
 * - `getPresence`: goes up only when the partition may have gone from empty to having rows, or back: on its first
 *   write, and on any write that couldn't say which units it changed. A read checks it to know whether there is
 *   anything to select from, without depending on every unit.
 */
export interface VersionAtom {
  /**
   * The partition's identity for dependency tracking: the store's name, and the partition's key parts joined into one
   * string.
   */
  key(parts: readonly string[]): [string, string];
  /**
   * The partition's version number: 0 before its first write, and one higher after every write that changes it.
   * Tracked: inside a tracking scope, the scope re-runs after any write that changes the partition.
   */
  get(parts: readonly string[]): number;
  /**
   * The version at which `unit` (a value of the unit column, such as a `player_id`) last changed in the partition, or 0
   * if it hasn't been written. Tracked for that unit only: inside a tracking scope, the scope re-runs only after a
   * write that changes that unit.
   */
  getUnit(parts: readonly string[], unit: string): number;
  /**
   * A number that goes up only when the partition may have gone from empty to having rows, or back. Tracked for that
   * only: inside a tracking scope, the scope re-runs on such a change, not on every write.
   */
  getPresence(parts: readonly string[]): number;
  /**
   * Records a write to the partition and notifies the readers it concerns, returning the partition's new version.
   * `changes` is the units the write changed (values of the unit column): readers of the whole partition and readers of
   * those units are notified, and readers of other units aren't. Omitted, or `ALL_UNITS`, means every unit changed. An
   * empty set means nothing changed, and bumps nothing.
   */
  bump(parts: readonly string[], changes?: ChangeSet): number;
  /**
   * Bumps every partition the atom knows of (written, or listened to), with every unit changed, so every reader of the
   * store re-reads. Used when the store moves to a different database.
   */
  bumpAll(): void;
  /** Calls `listener` after every write that changes the partition, and returns a function that unsubscribes it. */
  subscribe(parts: readonly string[], listener: () => void): () => void;
  /**
   * The partition's version number as a hook, re-rendering the component after every write that changes the partition.
   * While the component's read gate isn't live (its screen is hidden, say), it keeps returning the version it had and
   * doesn't re-render; when the gate is live again, it re-renders once if the partition changed meanwhile. `enabled`
   * false returns 0 and subscribes to nothing.
   */
  useVersion(parts: readonly string[], enabled?: boolean): number;
}

type Listener = () => void;

interface VersionEntry {
  value: number;
  /** The version at which every unit last counted as changed: the first write, and every write of all units. */
  epoch: number;
  presence: number;
  /** The units that changed since the epoch, with the version each changed at. */
  changedAt: Map<string, number>;
  listeners: Set<Listener>;
  unitListeners: Map<string, Set<Listener>>;
  presenceListeners: Set<Listener>;
}

/**
 * How many units a partition remembers changing since its epoch. Past this, a write moves the epoch instead, which
 * counts every unit changed: safe, since it wakes readers rather than leaving them stale, and it keeps a long session
 * over a large partition from holding a version for every unit it ever touched.
 */
const UNIT_MEMORY = 8192;

/**
 * Creates a store's {@link VersionAtom}: the version numbers, per partition and per unit, that its reads depend on and
 * its writes bump. `root` names the store in each partition's dependency identity. `defineSqliteStore` creates one per
 * store.
 */
export function createVersionAtom(root: string): VersionAtom {
  const specifier = (parts: readonly string[]): string => cacheKeyOf(parts);
  const key = (parts: readonly string[]): [string, string] => [root, specifier(parts)];

  const entries = new Map<string, VersionEntry>();
  const ensure = (spec: string): VersionEntry =>
    getOrCreate(entries, spec, () => ({
      value: 0,
      epoch: 0,
      presence: 0,
      changedAt: new Map(),
      listeners: new Set(),
      unitListeners: new Map(),
      presenceListeners: new Set(),
    }));

  const valueOf = (spec: string): number => entries.get(spec)?.value ?? 0;
  const unitValueOf = (spec: string, unit: string): number => {
    const entry = entries.get(spec);
    if (!entry) return 0;
    return Math.max(entry.epoch, entry.changedAt.get(unit) ?? 0);
  };
  const presenceOf = (spec: string): number => entries.get(spec)?.presence ?? 0;

  /**
   * Drops an entry nothing needs: never written, and nobody listening. A written entry must stay, since dropping it
   * resets its versions to 0, and a value cached at version 0 would then read as current.
   */
  const release = (spec: string, entry: VersionEntry): void => {
    if (entry.value !== 0 || entry.listeners.size || entry.unitListeners.size || entry.presenceListeners.size) return;
    if (entries.get(spec) !== entry) return;
    entries.delete(spec);
    // The descriptors follow the entry. One already handed to a sink keeps working, since it reads `entries` through
    // its spec on each call, and the next read rebuilds an identical one.
    partitionDeps.delete(spec);
    unitDeps.delete(spec);
    presenceDeps.delete(spec);
  };

  const listen = (spec: string, pick: (entry: VersionEntry) => Set<Listener>, listener: Listener): (() => void) => {
    const entry = ensure(spec);
    const set = pick(entry);
    set.add(listener);
    return () => {
      set.delete(listener);
      release(spec, entry);
    };
  };

  const subscribeUnit = (spec: string, unit: string, listener: Listener): (() => void) => {
    const entry = ensure(spec);
    const set = getOrCreate(entry.unitListeners, unit, () => new Set<Listener>());
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size && entry.unitListeners.get(unit) === set) entry.unitListeners.delete(unit);
      release(spec, entry);
    };
  };

  /**
   * One descriptor per partition, per unit and per presence, rather than one per read: `trackDependency` dedupes by
   * id and only ever reads the descriptor, so a shared instance behaves the same as a fresh one and costs nothing to
   * report again. Held apart from `entries`, since reading must not create an entry: that would widen what `bumpAll`
   * bumps.
   */
  const partitionDeps = new Map<string, Dep>();
  const unitDeps = new Map<string, Map<string, Dep>>();
  const presenceDeps = new Map<string, Dep>();

  const partitionDep = (spec: string): Dep =>
    getOrCreate(partitionDeps, spec, () => ({
      id: cacheKey(root, spec),
      subscribe: (listener: Listener) => listen(spec, (entry) => entry.listeners, listener),
      getVersion: () => valueOf(spec),
    }));
  // A unit's id extends its partition's with a separator no part or unit carries, and presence doubles it, so none of
  // the three can collide with another.
  const unitDep = (spec: string, unit: string): Dep =>
    getOrCreate(getOrCreate(unitDeps, spec, () => new Map<string, Dep>()), unit, () => ({
      id: `${cacheKey(root, spec)}${GROUP_SEP}${unit}`,
      subscribe: (listener: Listener) => subscribeUnit(spec, unit, listener),
      getVersion: () => unitValueOf(spec, unit),
    }));
  const presenceDep = (spec: string): Dep =>
    getOrCreate(presenceDeps, spec, () => ({
      id: `${cacheKey(root, spec)}${GROUP_SEP}${GROUP_SEP}`,
      subscribe: (listener: Listener) => listen(spec, (entry) => entry.presenceListeners, listener),
      getVersion: () => presenceOf(spec),
    }));

  const get = (parts: readonly string[]): number => {
    const spec = specifier(parts);
    trackDependency(partitionDep(spec));
    return valueOf(spec);
  };

  const getUnit = (parts: readonly string[], unit: string): number => {
    const spec = specifier(parts);
    trackDependency(unitDep(spec, unit));
    return unitValueOf(spec, unit);
  };

  const getPresence = (parts: readonly string[]): number => {
    const spec = specifier(parts);
    trackDependency(presenceDep(spec));
    return presenceOf(spec);
  };

  /**
   * Raises the version and wakes exactly the listeners the write concerns: every partition listener, and the listeners
   * of the units that changed — all of them when the write could not say which. A listener subscribed to several of
   * the changed units is called once. Synchronous; ingest bumps inside `notifyManager.batch` so re-renders coalesce.
   */
  const bumpSpec = (spec: string, changes: ChangeSet): number => {
    if (isUnchanged(changes)) return valueOf(spec);
    const entry = ensure(spec);
    const firstWrite = entry.value === 0;
    entry.value += 1;
    let effective = changes;
    if (changes === ALL_UNITS || firstWrite || entry.changedAt.size + changes.size > UNIT_MEMORY) {
      entry.epoch = entry.value;
      entry.changedAt.clear();
      effective = ALL_UNITS;
    } else {
      for (const unit of changes) entry.changedAt.set(unit, entry.value);
    }

    const wake = new Set<Listener>(entry.listeners);
    if (effective === ALL_UNITS) {
      entry.presence += 1;
      for (const listener of entry.presenceListeners) wake.add(listener);
      for (const set of entry.unitListeners.values()) for (const listener of set) wake.add(listener);
    } else {
      for (const unit of effective) {
        const set = entry.unitListeners.get(unit);
        if (set) for (const listener of set) wake.add(listener);
      }
    }
    wake.forEach((listener) => listener());
    return entry.value;
  };

  const bump = (parts: readonly string[], changes: ChangeSet = ALL_UNITS): number => bumpSpec(specifier(parts), changes);

  // Snapshotted first: a listener may write, and writing bumps, which mutates the map mid-walk.
  const bumpAll = (): void => Array.from(entries.keys()).forEach((spec) => bumpSpec(spec, ALL_UNITS));

  const subscribe = (parts: readonly string[], listener: Listener): (() => void) =>
    listen(specifier(parts), (entry) => entry.listeners, listener);

  /**
   * The host's read gate, applied to a subscription. While the gate is dead the subscription is dropped and the
   * version is HELD at what it was when the gate closed, so a read keeps showing the value it already had rather
   * than repainting with data nobody is looking at. When the gate goes live the subscription is restored and, only
   * if the version moved meanwhile, one notification is sent so the reader catches up in a single render.
   */
  function useHeldVersion(spec: string, enabled: boolean) {
    const gate = readGateRuntime().useReadGate();
    // Non-null exactly while held. Written from the subscription below, never from `getSnapshot`, which stays pure.
    const held = useRef<number | null>(null);

    const subscribeHeld = useCallback(
      (onChange: () => void) => {
        if (!enabled) return () => {};
        let unsub: (() => void) | null = null;
        const sync = (announce: boolean) => {
          if (gate.isLive()) {
            const wasHeld = held.current;
            held.current = null;
            if (!unsub) unsub = listen(spec, (entry) => entry.listeners, onChange);
            // Nothing moved while away, so there is nothing to catch up on and no render to spend.
            if (announce && wasHeld !== null && wasHeld !== valueOf(spec)) onChange();
          } else {
            // Captured as the gate closes, so a bump arriving later cannot move what a held read shows.
            held.current = valueOf(spec);
            unsub?.();
            unsub = null;
          }
        };
        sync(false);
        const offGate = gate.onChange(() => sync(true));
        return () => {
          unsub?.();
          offGate();
          held.current = null;
        };
      },
      [spec, enabled, gate],
    );

    const getSnapshot = useCallback(() => {
      if (!enabled) return 0;
      const version = held.current;
      return version !== null ? version : valueOf(spec);
    }, [spec, enabled]);

    return { subscribe: subscribeHeld, getSnapshot };
  }

  const useVersion = (parts: readonly string[], enabled?: boolean): number => {
    const spec = specifier(parts);
    const isEnabled = (enabled ?? true) && addressesPartition(parts);
    const { subscribe: subscribeHeld, getSnapshot } = useHeldVersion(spec, isEnabled);
    return useSyncExternalStore(subscribeHeld, getSnapshot, getSnapshot);
  };

  return { key, get, getUnit, getPresence, bump, bumpAll, subscribe, useVersion };
}
