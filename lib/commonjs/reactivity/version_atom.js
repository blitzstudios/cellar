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
var _runtime = require("../runtime.js");
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

  /**
   * One descriptor per partition rather than one per read. `root` is fixed for the atom and the closures capture
   * nothing but `spec`, so what `get` used to build every call -- an id string, an object and two closures -- was
   * identical each time, and `get` runs once per partition per read. {@link trackDependency} dedupes by `id` and
   * only ever reads the descriptor, so one shared instance behaves the same as a fresh one.
   *
   * Held apart from `entries` because `get` deliberately does not create an entry: seeding one per read would widen
   * what `bumpAll` bumps. Its keys are partitions, the same space `entries` occupies.
   */
  const deps = new Map();
  const depFor = spec => (0, _collections.getOrCreate)(deps, spec, () => ({
    id: (0, _args_key.cacheKey)(root, spec),
    subscribe: listener => subscribeSpec(spec, listener),
    getVersion: () => getSpec(spec)
  }));
  const get = parts => {
    const spec = specifier(parts);
    (0, _tracking.trackDependency)(depFor(spec));
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
      if (entry.listeners.size === 0 && entry.value === 0 && entries.get(spec) === entry) {
        entries.delete(spec);
        // Follows the entry rather than outliving it. A descriptor already handed to a sink keeps working -- it
        // reads `entries` through `spec` on each call -- and the next read rebuilds an identical one.
        deps.delete(spec);
      }
    };
  };
  const sumOf = specs => {
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
  function useHeldVersion(specs, activeKey, enabled) {
    const gate = (0, _runtime.readGateRuntime)().useReadGate();
    // Non-null exactly while held. Written from the subscription below, never from `getSnapshot`, which stays pure.
    const held = (0, _react.useRef)(null);
    const subscribe = (0, _react.useCallback)(onChange => {
      if (!enabled) return () => {};
      let unsubs = null;
      const attach = () => {
        if (!unsubs) unsubs = specs.map(spec => subscribeSpec(spec, onChange));
      };
      const detach = () => {
        unsubs?.forEach(unsub => unsub());
        unsubs = null;
      };
      const sync = announce => {
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
    [activeKey, enabled, gate]);
    const getSnapshot = (0, _react.useCallback)(() => {
      if (!enabled) return 0;
      const version = held.current;
      return version !== null ? version : sumOf(specs);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeKey is the stable identity of `specs`; the gate arrives through the ref
    [activeKey, enabled]);
    return {
      subscribe,
      getSnapshot
    };
  }
  const useVersion = (parts, enabled) => {
    const spec = specifier(parts);
    const isEnabled = (enabled ?? true) && isLive(parts);
    const specs = (0, _react.useMemo)(() => [spec], [spec]);
    const {
      subscribe,
      getSnapshot
    } = useHeldVersion(specs, spec, isEnabled);
    return (0, _shim.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
  };

  /** The subscribe-and-select engine behind both hooks. `activeKey` is the stable identity of `specs`. */
  function useSpecsSelect(specs, activeKey, enabled, deps, compute, isEqual, empty) {
    const {
      subscribe,
      getSnapshot: getVersionSnapshot
    } = useHeldVersion(specs, activeKey, enabled);
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