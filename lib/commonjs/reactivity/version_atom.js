"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.addressesPartition = exports.NO_PARTS = void 0;
exports.createVersionAtom = createVersionAtom;
exports.partitionEntries = partitionEntries;
var _react = require("react");
var _shim = require("use-sync-external-store/shim");
var _args_key = require("../args_key.js");
var _collections = require("../collections.js");
var _runtime = require("../runtime.js");
var _tracking = require("./tracking.js");
var _change_set = require("../table/change_set.js");
/**
 * How a store tells its readers about writes: a version number per partition, and the version at which each unit last
 * changed. A write bumps the units it changed; a reader depends on the units it read, or on the whole partition.
 */

/** Whether key parts name a partition: at least one part, and none empty. */
const addressesPartition = parts => parts.length > 0 && parts.every(Boolean);

/** An empty, shared list of key parts, for a hook that must still run while it names no partition. */
exports.addressesPartition = addressesPartition;
const NO_PARTS = exports.NO_PARTS = Object.freeze([]);

/** A partition's key together with its key parts. */

/** Pairs each key with its key parts, in the same order, including keys that name no partition. */
function partitionEntries(keys, toParts) {
  return keys.map(key => ({
    key,
    parts: toParts(key)
  }));
}

/**
 * A store's version numbers, which is how reads learn about writes. Each partition has three, and reading any of them
 * inside a tracking scope makes the derivation depend on it:
 *
 * - `get`: the partition's version, which changes on every write that changed anything. A read of the whole partition
 *   depends on it.
 * - `getUnit`: the version at which one unit last changed. A read of named units depends only on those, so a write to
 *   other units doesn't re-run it.
 * - `getPresence`: changes only when the partition may have gone from empty to having rows, or back: on its first
 *   write, and on any write that couldn't say which units it changed. A read checks it to know whether there is anything
 *   to select from.
 */

/**
 * How many units a partition remembers changing since its epoch. Past this, a write moves the epoch instead, which
 * counts every unit changed: safe, since it wakes readers rather than leaving them stale, and it keeps a long session
 * over a large partition from holding a version for every unit it ever touched.
 */
const UNIT_MEMORY = 8192;

/** Creates a store's {@link VersionAtom}. `root` is the store's name, the first part of each dependency id. */
function createVersionAtom(root) {
  const specifier = parts => (0, _args_key.cacheKeyOf)(parts);
  const key = parts => [root, specifier(parts)];
  const entries = new Map();
  const ensure = spec => (0, _collections.getOrCreate)(entries, spec, () => ({
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
    const set = (0, _collections.getOrCreate)(entry.unitListeners, unit, () => new Set());
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
  const partitionDep = spec => (0, _collections.getOrCreate)(partitionDeps, spec, () => ({
    id: (0, _args_key.cacheKey)(root, spec),
    subscribe: listener => listen(spec, entry => entry.listeners, listener),
    getVersion: () => valueOf(spec)
  }));
  // A unit's id extends its partition's with a separator no part or unit carries, and presence doubles it, so none of
  // the three can collide with another.
  const unitDep = (spec, unit) => (0, _collections.getOrCreate)((0, _collections.getOrCreate)(unitDeps, spec, () => new Map()), unit, () => ({
    id: `${(0, _args_key.cacheKey)(root, spec)}${_args_key.GROUP_SEP}${unit}`,
    subscribe: listener => subscribeUnit(spec, unit, listener),
    getVersion: () => unitValueOf(spec, unit)
  }));
  const presenceDep = spec => (0, _collections.getOrCreate)(presenceDeps, spec, () => ({
    id: `${(0, _args_key.cacheKey)(root, spec)}${_args_key.GROUP_SEP}${_args_key.GROUP_SEP}`,
    subscribe: listener => listen(spec, entry => entry.presenceListeners, listener),
    getVersion: () => presenceOf(spec)
  }));
  const get = parts => {
    const spec = specifier(parts);
    (0, _tracking.trackDependency)(partitionDep(spec));
    return valueOf(spec);
  };
  const getUnit = (parts, unit) => {
    const spec = specifier(parts);
    (0, _tracking.trackDependency)(unitDep(spec, unit));
    return unitValueOf(spec, unit);
  };
  const getPresence = parts => {
    const spec = specifier(parts);
    (0, _tracking.trackDependency)(presenceDep(spec));
    return presenceOf(spec);
  };

  /**
   * Raises the version and wakes exactly the listeners the write concerns: every partition listener, and the listeners
   * of the units that changed — all of them when the write could not say which. A listener subscribed to several of
   * the changed units is called once. Synchronous; ingest bumps inside `notifyManager.batch` so re-renders coalesce.
   */
  const bumpSpec = (spec, changes) => {
    if ((0, _change_set.isUnchanged)(changes)) return valueOf(spec);
    const entry = ensure(spec);
    const firstWrite = entry.value === 0;
    entry.value += 1;
    let effective = changes;
    if (changes === _change_set.ALL_UNITS || firstWrite || entry.changedAt.size + changes.size > UNIT_MEMORY) {
      entry.epoch = entry.value;
      entry.changedAt.clear();
      effective = _change_set.ALL_UNITS;
    } else {
      for (const unit of changes) entry.changedAt.set(unit, entry.value);
    }
    const wake = new Set(entry.listeners);
    if (effective === _change_set.ALL_UNITS) {
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
  const bump = (parts, changes = _change_set.ALL_UNITS) => bumpSpec(specifier(parts), changes);

  // Snapshotted first: a listener may write, and writing bumps, which mutates the map mid-walk.
  const bumpAll = () => Array.from(entries.keys()).forEach(spec => bumpSpec(spec, _change_set.ALL_UNITS));
  const subscribe = (parts, listener) => listen(specifier(parts), entry => entry.listeners, listener);

  /**
   * The host's read gate, applied to a subscription. While the gate is dead the subscription is dropped and the
   * version is HELD at what it was when the gate closed, so a read keeps showing the value it already had rather
   * than repainting with data nobody is looking at. When the gate goes live the subscription is restored and, only
   * if the version moved meanwhile, one notification is sent so the reader catches up in a single render.
   */
  function useHeldVersion(spec, enabled) {
    const gate = (0, _runtime.readGateRuntime)().useReadGate();
    // Non-null exactly while held. Written from the subscription below, never from `getSnapshot`, which stays pure.
    const held = (0, _react.useRef)(null);
    const subscribeHeld = (0, _react.useCallback)(onChange => {
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
    const getSnapshot = (0, _react.useCallback)(() => {
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
    return (0, _shim.useSyncExternalStore)(subscribeHeld, getSnapshot, getSnapshot);
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