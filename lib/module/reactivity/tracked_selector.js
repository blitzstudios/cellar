"use strict";

/**
 * A stand-in for Reselect's `createSelector`, for a Redux selector that reaches into off-heap data — usually by
 * calling a service inside its `resultFn`. Reselect memoizes on the declared inputs alone, so such a selector holds
 * its old result after a partition is written and the screen never repaints. This one records the partitions the
 * `resultFn` touched and treats them as inputs as well.
 */

import { isTracking, runTracked, trackDependency } from "./tracking.js";

/** One entry in the `inputs` array: takes the selector's own arguments and returns a value `resultFn` receives. */

/** Decides whether an input is unchanged and a memoized result may stand. */

/** {@link createTrackedSelector}'s third argument: how its inputs are compared, how much it remembers, and what to call it in a warning. */

const DEFAULT_CACHE_MAX = 8;

/**
 * Builds a selector calling `resultFn` with the values of `inputs`, memoized per argument set and recomputed when
 * an input changes or a partition `resultFn` read is written. The consumer must be inside a tracking scope — a
 * `useTrackedStores` component or a `useValue` hook — or the result is correct but nothing repaints on a write.
 */

export function createTrackedSelector(inputs, resultFn, options) {
  const inputEqual = options?.inputEqual ?? Object.is;
  const cacheMax = options?.cacheMax ?? DEFAULT_CACHE_MAX;

  // Emits into the scope *outside* this selector — its own nested scope is already popped by now.
  const forwardDeps = deps => {
    for (const dep of deps) trackDependency(dep);
  };
  let warnedOutsideScope = false;
  const warnIfOrphanedDeps = deps => {
    if (!__DEV__ || warnedOutsideScope || deps.length === 0 || isTracking()) return;
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
    } = runTracked(() => resultFn(...inputValues));
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