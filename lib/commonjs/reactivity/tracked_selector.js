"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createTrackedSelector = createTrackedSelector;
var _tracking = require("./tracking.js");
/**
 * A replacement for Reselect's `createSelector`, for a Redux selector that reads store data, usually by calling a
 * service in its `resultFn`. Reselect only re-runs when its inputs change, so it would keep a stale result after a
 * write. This one also re-runs when anything `resultFn` read from a store changes.
 */

/** One entry in the `inputs` array: takes the selector's own arguments and returns a value `resultFn` receives. */

/** Whether two values of an input are equal, so the cached result can be reused. */

/** Options for {@link createTrackedSelector}. */

const DEFAULT_CACHE_MAX = 8;

/**
 * Creates a selector that calls `resultFn` with the values of `inputs`, caching the result per argument set until an
 * input changes or something `resultFn` read from a store changes. Call it inside a tracking scope, such as a
 * `useTrackedStores` component or a `useValue` hook; elsewhere its results are correct but a write re-renders nothing.
 */

function createTrackedSelector(inputs, resultFn, options) {
  const inputEqual = options?.inputEqual ?? Object.is;
  const cacheMax = options?.cacheMax ?? DEFAULT_CACHE_MAX;

  // Emits into the scope *outside* this selector — its own nested scope is already popped by now.
  const forwardDeps = deps => {
    for (const dep of deps) (0, _tracking.trackDependency)(dep);
  };
  let warnedOutsideScope = false;
  const warnIfOrphanedDeps = deps => {
    if (!__DEV__ || warnedOutsideScope || deps.length === 0 || (0, _tracking.isTracking)()) return;
    warnedOutsideScope = true;
    const label = options?.debugLabel ?? `[${deps.map(dep => dep.id).join(', ')}]`;
    // eslint-disable-next-line no-console
    console.warn(`[tracked-selector] ${label} read off-heap partitions but ran outside a tracking scope, so its consumer ` + `won't repaint when they change. Wrap the consuming component in withTrackedStores/useTrackedStores ` + `(or read via a *.useValue hook). Safe to ignore for one-shot imperative reads.`);
  };
  const sameInputs = (left, right) => left.length === right.length && left.every((value, index) => inputEqual(value, right[index]));
  const depsUnchanged = entry => entry.deps.every((dep, index) => dep.getVersion() === entry.depVersions[index]);

  // Most-recently-used first, so the common alternating-args case settles at the head.
  const cache = [];
  return (...args) => {
    const inputValues = inputs.map(select => select(...args));
    const hit = cache.findIndex(entry => sameInputs(entry.inputValues, inputValues));
    if (hit !== -1) {
      const entry = cache[hit];
      if (depsUnchanged(entry)) {
        if (hit > 0) {
          cache.splice(hit, 1);
          cache.unshift(entry);
        }
        // Forward on a hit too, or a consumer whose first call hits subscribes to nothing.
        forwardDeps(entry.deps);
        warnIfOrphanedDeps(entry.deps);
        return entry.result;
      }
      cache.splice(hit, 1);
    }
    const {
      value,
      deps
    } = (0, _tracking.runTracked)(() => resultFn(...inputValues));
    cache.unshift({
      inputValues,
      deps,
      depVersions: deps.map(dep => dep.getVersion()),
      result: value
    });
    if (cache.length > cacheMax) cache.length = cacheMax;
    forwardDeps(deps);
    warnIfOrphanedDeps(deps);
    return value;
  };
}
//# sourceMappingURL=tracked_selector.js.map