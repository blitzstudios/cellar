"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.NO_PARTS = void 0;
exports.createVersionAtom = createVersionAtom;
exports.isLive = void 0;
exports.partitionEntries = partitionEntries;
var _react = require("react");
var _shim = require("use-sync-external-store/shim");
var _withSelector = require("use-sync-external-store/shim/with-selector");
var _args_key = require("../args_key.js");
var _collections = require("../collections.js");
var _tracking = require("./tracking.js");
/** The per-partition version counter that stands in for change notification: a write bumps it, a reader watches it. */

/** Whether a part list addresses a real partition: at least one part, and every part filled in. */
const isLive = parts => parts.length > 0 && parts.every(Boolean);

/** Stable empty part list, for a hook that must run in the same position while addressing nothing. */
exports.isLive = isLive;
const NO_PARTS = exports.NO_PARTS = Object.freeze([]);

/** A partition key paired with the parts it is keyed by, for a caller needing both over a set of them — a presence probe across a `readMany`. */

/** Each key paired with its parts, gaps included, so the result stays parallel with the keys named. */
function partitionEntries(keys, toParts) {
  return keys.map(key => ({
    key,
    parts: toParts(key)
  }));
}

/**
 * The change notification for a whole store, one integer per partition: a write bumps, a reactive reader subscribes
 * through `useVersion` / `useSelect`, and `get` reads imperatively while registering the partition with any active
 * tracking scope. A store is handed one by its spine and passes it to `definePartitions`.
 */

/**
 * Builds the atom for one store, `root` naming it in the dependency ids its reads report. Its entries are module-level
 * and one per partition, so a write wakes every reader of that partition and no reader of any other.
 */
function createVersionAtom(root) {
  const specifier = parts => (0, _args_key.cacheKey)(...parts);
  const key = parts => [root, specifier(parts)];
  const entries = new Map();
  const ensure = spec => (0, _collections.getOrCreate)(entries, spec, () => ({
    value: 0,
    listeners: new Set()
  }));
  const getSpec = spec => entries.get(spec)?.value ?? 0;
  const get = parts => {
    const spec = specifier(parts);
    (0, _tracking.trackDependency)({
      id: (0, _args_key.cacheKey)(root, spec),
      subscribe: listener => subscribeSpec(spec, listener),
      getVersion: () => getSpec(spec)
    });
    return getSpec(spec);
  };
  const bumpSpec = spec => {
    const entry = ensure(spec);
    entry.value += 1;
    // Synchronous fan-out; ingest bumps inside `notifyManager.batch` so the re-renders coalesce.
    entry.listeners.forEach(listener => listener());
    return entry.value;
  };
  const bump = parts => bumpSpec(specifier(parts));

  // Snapshotted first: a listener may write, and writing bumps, which mutates the map mid-walk.
  const bumpAll = () => Array.from(entries.keys()).forEach(bumpSpec);
  const subscribeSpec = (spec, listener) => {
    const entry = ensure(spec);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      // A written entry must stay: dropping it resets `get` to 0, and a value cached with version 0 reads as current.
      if (entry.listeners.size === 0 && entry.value === 0 && entries.get(spec) === entry) entries.delete(spec);
    };
  };
  const useVersion = (parts, enabled) => {
    const spec = specifier(parts);
    const isEnabled = (enabled ?? true) && isLive(parts);
    const subscribe = (0, _react.useCallback)(onChange => isEnabled ? subscribeSpec(spec, onChange) : () => {}, [spec, isEnabled]);
    const getSnapshot = (0, _react.useCallback)(() => isEnabled ? getSpec(spec) : 0, [spec, isEnabled]);
    return (0, _shim.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
  };

  /** The subscribe-and-select engine behind both hooks. `activeKey` is the stable identity of `specs`. */
  function useSpecsSelect(specs, activeKey, enabled, deps, compute, isEqual, empty) {
    const subscribe = (0, _react.useCallback)(onChange => {
      if (!enabled) return () => {};
      const unsubs = specs.map(spec => subscribeSpec(spec, onChange));
      return () => unsubs.forEach(unsub => unsub());
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeKey is the stable identity of `specs`
    [activeKey, enabled]);
    const getVersionSnapshot = (0, _react.useCallback)(() => {
      if (!enabled) return 0;
      let sum = 0;
      for (const spec of specs) sum += getSpec(spec);
      return sum;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeKey is the stable identity of `specs`
    [activeKey, enabled]);
    // `subscribe` above covers whatever `compute` reads, which is what the render-phase guard checks for.
    const selector = (0, _react.useCallback)(() => enabled ? (0, _tracking.runSubscribed)(compute) : empty,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the read-arg identity; `compute`/`empty` are stable per call site.
    [enabled, ...deps]);
    return (0, _withSelector.useSyncExternalStoreWithSelector)(subscribe, getVersionSnapshot, getVersionSnapshot, selector, isEqual);
  }
  const useSelect = (parts, enabled, deps, compute, isEqual, empty) => {
    const spec = specifier(parts);
    const specs = (0, _react.useMemo)(() => [spec], [spec]);
    return useSpecsSelect(specs, spec, enabled, deps, compute, isEqual, empty);
  };
  const useSelectMany = (partsList, enabled, deps, compute, isEqual, empty) => {
    const specsKey = (0, _args_key.partitionsKey)(partsList);
    const specs = (0, _react.useMemo)(() => partsList.filter(isLive).map(parts => specifier(parts)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- specsKey is the stable identity of the partition set
    [specsKey]);
    return useSpecsSelect(specs, specs.join(_args_key.GROUP_SEP), enabled, deps, compute, isEqual, empty);
  };
  const subscribe = (parts, listener) => subscribeSpec(specifier(parts), listener);
  return {
    key,
    get,
    bump,
    bumpAll,
    subscribe,
    useVersion,
    useSelect,
    useSelectMany
  };
}
//# sourceMappingURL=version_atom.js.map