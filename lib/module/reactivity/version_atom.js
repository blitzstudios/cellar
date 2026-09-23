"use strict";

/**
 * The change notification for a store: one counter per partition, and beneath it the version each unit last changed
 * at. A write bumps with the units it changed; a reader depends on the units it read, or on the whole partition.
 */

import { useCallback, useRef } from 'react';
import { useSyncExternalStore } from 'use-sync-external-store/shim';
import { cacheKey, GROUP_SEP, cacheKeyOf } from "../args_key.js";
import { getOrCreate } from "../collections.js";
import { readGateRuntime } from "../runtime.js";
import { trackDependency } from "./tracking.js";
import { ALL_UNITS, isUnchanged } from "../table/change_set.js";

/** Whether a part list addresses a real partition: at least one part, and every part filled in. */
export const addressesPartition = parts => parts.length > 0 && parts.every(Boolean);

/** Stable empty part list, for a hook that must run in the same position while addressing nothing. */
export const NO_PARTS = Object.freeze([]);

/** A partition key paired with the parts it is keyed by, for a caller needing both over a set of them — a presence probe across a `readMany`. */

/** Each key paired with its parts, gaps included, so the result stays parallel with the keys named. */
export function partitionEntries(keys, toParts) {
  return keys.map(key => ({
    key,
    parts: toParts(key)
  }));
}

/**
 * The change notification for a whole store. Three things can be depended on for each partition, and each reports
 * itself to an active tracking scope when read:
 *
 * - `get` — the partition's version, which moves on every write that changed anything. A read over the whole partition
 *   depends on this.
 * - `getUnit` — the version one unit last changed at. A read of named units depends on these alone, so a write that
 *   changed other units leaves it asleep.
 * - `getPresence` — which moves only when the partition may have gained or lost rows altogether: its first write, and
 *   any write that could not say which units it changed. Whether a partition holds rows at all is what gates a read.
 */

/**
 * How many units a partition remembers changing since its epoch. Past this, a write moves the epoch instead, which
 * counts every unit changed: safe, since it wakes readers rather than leaving them stale, and it keeps a long session
 * over a large partition from holding a version for every unit it ever touched.
 */
const UNIT_MEMORY = 8192;

/** Builds the atom for one store, `root` naming it in the dependency ids its reads report. */
export function createVersionAtom(root) {
  const specifier = parts => cacheKeyOf(parts);
  const key = parts => [root, specifier(parts)];
  const entries = new Map();
  const ensure = spec => getOrCreate(entries, spec, () => ({
    value: 0,
    epoch: 0,
    presence: 0,
    changedAt: new Map(),
    listeners: new Set(),
    unitListeners: new Map(),
    presenceListeners: new Set()
  }));
  const valueOf = spec => entries.get(spec)?.value ?? 0;
  const unitValueOf = (spec, unit) => {
    const entry = entries.get(spec);
    if (!entry) return 0;
    return Math.max(entry.epoch, entry.changedAt.get(unit) ?? 0);
  };
  const presenceOf = spec => entries.get(spec)?.presence ?? 0;

  /**
   * Drops an entry nothing needs: never written, and nobody listening. A written entry must stay, since dropping it
   * resets its versions to 0, and a value cached at version 0 would then read as current.
   */
  const release = (spec, entry) => {
    if (entry.value !== 0 || entry.listeners.size || entry.unitListeners.size || entry.presenceListeners.size) return;
    if (entries.get(spec) !== entry) return;
    entries.delete(spec);
    // The descriptors follow the entry. One already handed to a sink keeps working, since it reads `entries` through
    // its spec on each call, and the next read rebuilds an identical one.
    partitionDeps.delete(spec);
    unitDeps.delete(spec);
    presenceDeps.delete(spec);
  };
  const listen = (spec, pick, listener) => {
    const entry = ensure(spec);
    const set = pick(entry);
    set.add(listener);
    return () => {
      set.delete(listener);
      release(spec, entry);
    };
  };
  const subscribeUnit = (spec, unit, listener) => {
    const entry = ensure(spec);
    const set = getOrCreate(entry.unitListeners, unit, () => new Set());
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
  const partitionDeps = new Map();
  const unitDeps = new Map();
  const presenceDeps = new Map();
  const partitionDep = spec => getOrCreate(partitionDeps, spec, () => ({
    id: cacheKey(root, spec),
    subscribe: listener => listen(spec, entry => entry.listeners, listener),
    getVersion: () => valueOf(spec)
  }));
  // A unit's id extends its partition's with a separator no part or unit carries, and presence doubles it, so none of
  // the three can collide with another.
  const unitDep = (spec, unit) => getOrCreate(getOrCreate(unitDeps, spec, () => new Map()), unit, () => ({
    id: `${cacheKey(root, spec)}${GROUP_SEP}${unit}`,
    subscribe: listener => subscribeUnit(spec, unit, listener),
    getVersion: () => unitValueOf(spec, unit)
  }));
  const presenceDep = spec => getOrCreate(presenceDeps, spec, () => ({
    id: `${cacheKey(root, spec)}${GROUP_SEP}${GROUP_SEP}`,
    subscribe: listener => listen(spec, entry => entry.presenceListeners, listener),
    getVersion: () => presenceOf(spec)
  }));
  const get = parts => {
    const spec = specifier(parts);
    trackDependency(partitionDep(spec));
    return valueOf(spec);
  };
  const getUnit = (parts, unit) => {
    const spec = specifier(parts);
    trackDependency(unitDep(spec, unit));
    return unitValueOf(spec, unit);
  };
  const getPresence = parts => {
    const spec = specifier(parts);
    trackDependency(presenceDep(spec));
    return presenceOf(spec);
  };

  /**
   * Raises the version and wakes exactly the listeners the write concerns: every partition listener, and the listeners
   * of the units that changed — all of them when the write could not say which. A listener subscribed to several of
   * the changed units is called once. Synchronous; ingest bumps inside `notifyManager.batch` so re-renders coalesce.
   */
  const bumpSpec = (spec, changes) => {
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
    const wake = new Set(entry.listeners);
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
    wake.forEach(listener => listener());
    return entry.value;
  };
  const bump = (parts, changes = ALL_UNITS) => bumpSpec(specifier(parts), changes);

  // Snapshotted first: a listener may write, and writing bumps, which mutates the map mid-walk.
  const bumpAll = () => Array.from(entries.keys()).forEach(spec => bumpSpec(spec, ALL_UNITS));
  const subscribe = (parts, listener) => listen(specifier(parts), entry => entry.listeners, listener);

  /**
   * The host's read gate, applied to a subscription. While the gate is dead the subscription is dropped and the
   * version is HELD at what it was when the gate closed, so a read keeps showing the value it already had rather
   * than repainting with data nobody is looking at. When the gate goes live the subscription is restored and, only
   * if the version moved meanwhile, one notification is sent so the reader catches up in a single render.
   */
  function useHeldVersion(spec, enabled) {
    const gate = readGateRuntime().useReadGate();
    // Non-null exactly while held. Written from the subscription below, never from `getSnapshot`, which stays pure.
    const held = useRef(null);
    const subscribeHeld = useCallback(onChange => {
      if (!enabled) return () => {};
      let unsub = null;
      const sync = announce => {
        if (gate.isLive()) {
          const wasHeld = held.current;
          held.current = null;
          if (!unsub) unsub = listen(spec, entry => entry.listeners, onChange);
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
    }, [spec, enabled, gate]);
    const getSnapshot = useCallback(() => {
      if (!enabled) return 0;
      const version = held.current;
      return version !== null ? version : valueOf(spec);
    }, [spec, enabled]);
    return {
      subscribe: subscribeHeld,
      getSnapshot
    };
  }
  const useVersion = (parts, enabled) => {
    const spec = specifier(parts);
    const isEnabled = (enabled ?? true) && addressesPartition(parts);
    const {
      subscribe: subscribeHeld,
      getSnapshot
    } = useHeldVersion(spec, isEnabled);
    return useSyncExternalStore(subscribeHeld, getSnapshot, getSnapshot);
  };
  return {
    key,
    get,
    getUnit,
    getPresence,
    bump,
    bumpAll,
    subscribe,
    useVersion
  };
}
//# sourceMappingURL=version_atom.js.map