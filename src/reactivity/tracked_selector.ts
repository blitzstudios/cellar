/**
 * A replacement for Reselect's `createSelector`, for a Redux selector that reads store data, usually by calling a
 * service in its `resultFn`. Reselect only re-runs when its inputs change, so it would keep a stale result after a
 * write. This one also re-runs when anything `resultFn` read from a store changes.
 */

import { Dep, isTracking, runTracked, trackDependency } from './tracking';

/** One entry in the `inputs` array: takes the selector's own arguments and returns a value `resultFn` receives. */
export type InputSelector<Args extends readonly unknown[], T = unknown> = (...args: Args) => T;

/** Whether two values of an input are equal, so the cached result can be reused. */
export type EqualityFn = (left: unknown, right: unknown) => boolean;

/** Options for {@link createTrackedSelector}. */
export interface TrackedSelectorOptions {
  /**
   * How input values are compared; `Object.is` by default. Pass a shallow or deep compare for inputs rebuilt on every
   * call.
   */
  inputEqual?: EqualityFn;
  /** The selector's name in the dev warning about being called outside a tracking scope. */
  debugLabel?: string;
  /** How many argument sets to cache results for; 8 by default. */
  cacheMax?: number;
}

const DEFAULT_CACHE_MAX = 8;

interface CacheEntry<R> {
  inputValues: unknown[];
  deps: Dep[];
  depVersions: number[];
  result: R;
}

/**
 * Creates a selector that calls `resultFn` with the values of `inputs`, caching the result per argument set until an
 * input changes or something `resultFn` read from a store changes. Call it inside a tracking scope, such as a
 * `useTrackedStores` component or a `useValue` hook; elsewhere its results are correct but a write re-renders nothing.
 */
export function createTrackedSelector<Args extends readonly unknown[], V1, R>(
  inputs: readonly [InputSelector<Args, V1>],
  resultFn: (v1: V1) => R,
  options?: TrackedSelectorOptions,
): (...args: Args) => R;
export function createTrackedSelector<Args extends readonly unknown[], V1, V2, R>(
  inputs: readonly [InputSelector<Args, V1>, InputSelector<Args, V2>],
  resultFn: (v1: V1, v2: V2) => R,
  options?: TrackedSelectorOptions,
): (...args: Args) => R;
export function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, R>(
  inputs: readonly [InputSelector<Args, V1>, InputSelector<Args, V2>, InputSelector<Args, V3>],
  resultFn: (v1: V1, v2: V2, v3: V3) => R,
  options?: TrackedSelectorOptions,
): (...args: Args) => R;
export function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, R>(
  inputs: readonly [InputSelector<Args, V1>, InputSelector<Args, V2>, InputSelector<Args, V3>, InputSelector<Args, V4>],
  resultFn: (v1: V1, v2: V2, v3: V3, v4: V4) => R,
  options?: TrackedSelectorOptions,
): (...args: Args) => R;
export function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, R>(
  inputs: readonly [InputSelector<Args, V1>, InputSelector<Args, V2>, InputSelector<Args, V3>, InputSelector<Args, V4>, InputSelector<Args, V5>],
  resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5) => R,
  options?: TrackedSelectorOptions,
): (...args: Args) => R;
export function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, R>(
  inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
  ],
  resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6) => R,
  options?: TrackedSelectorOptions,
): (...args: Args) => R;
export function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, R>(
  inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
    InputSelector<Args, V7>,
  ],
  resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7) => R,
  options?: TrackedSelectorOptions,
): (...args: Args) => R;
export function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, V8, R>(
  inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
    InputSelector<Args, V7>,
    InputSelector<Args, V8>,
  ],
  resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7, v8: V8) => R,
  options?: TrackedSelectorOptions,
): (...args: Args) => R;
export function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, V8, V9, R>(
  inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
    InputSelector<Args, V7>,
    InputSelector<Args, V8>,
    InputSelector<Args, V9>,
  ],
  resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7, v8: V8, v9: V9) => R,
  options?: TrackedSelectorOptions,
): (...args: Args) => R;
export function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, R>(
  inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
    InputSelector<Args, V7>,
    InputSelector<Args, V8>,
    InputSelector<Args, V9>,
    InputSelector<Args, V10>,
  ],
  resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7, v8: V8, v9: V9, v10: V10) => R,
  options?: TrackedSelectorOptions,
): (...args: Args) => R;
export function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, R>(
  inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
    InputSelector<Args, V7>,
    InputSelector<Args, V8>,
    InputSelector<Args, V9>,
    InputSelector<Args, V10>,
    InputSelector<Args, V11>,
  ],
  resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7, v8: V8, v9: V9, v10: V10, v11: V11) => R,
  options?: TrackedSelectorOptions,
): (...args: Args) => R;
export function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12, R>(
  inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
    InputSelector<Args, V7>,
    InputSelector<Args, V8>,
    InputSelector<Args, V9>,
    InputSelector<Args, V10>,
    InputSelector<Args, V11>,
    InputSelector<Args, V12>,
  ],
  resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7, v8: V8, v9: V9, v10: V10, v11: V11, v12: V12) => R,
  options?: TrackedSelectorOptions,
): (...args: Args) => R;
export function createTrackedSelector<Args extends readonly unknown[], R>(
  inputs: ReadonlyArray<InputSelector<Args>>,
  resultFn: (...inputValues: any[]) => R,
  options?: TrackedSelectorOptions,
): (...args: Args) => R {
  const inputEqual = options?.inputEqual ?? Object.is;
  const cacheMax = options?.cacheMax ?? DEFAULT_CACHE_MAX;

  // Emits into the scope *outside* this selector — its own nested scope is already popped by now.
  const forwardDeps = (deps: readonly Dep[]): void => {
    for (const dep of deps) trackDependency(dep);
  };

  let warnedOutsideScope = false;
  const warnIfOrphanedDeps = (deps: readonly Dep[]): void => {
    if (!__DEV__ || warnedOutsideScope || deps.length === 0 || isTracking()) return;
    warnedOutsideScope = true;
    const label = options?.debugLabel ?? `[${deps.map((dep) => dep.id).join(', ')}]`;
    // eslint-disable-next-line no-console
    console.warn(
      `[tracked-selector] ${label} read off-heap partitions but ran outside a tracking scope, so its consumer ` +
        `won't repaint when they change. Wrap the consuming component in withTrackedStores/useTrackedStores ` +
        `(or read via a *.useValue hook). Safe to ignore for one-shot imperative reads.`,
    );
  };

  const sameInputs = (left: readonly unknown[], right: readonly unknown[]): boolean =>
    left.length === right.length && left.every((value, index) => inputEqual(value, right[index]));

  const depsUnchanged = (entry: CacheEntry<R>): boolean => entry.deps.every((dep, index) => dep.getVersion() === entry.depVersions[index]);

  // Most-recently-used first, so the common alternating-args case settles at the head.
  const cache: CacheEntry<R>[] = [];

  return (...args: Args): R => {
    const inputValues = inputs.map((select) => select(...args));

    const hit = cache.findIndex((entry) => sameInputs(entry.inputValues, inputValues));
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

    const { value, deps } = runTracked(() => resultFn(...inputValues));
    cache.unshift({ inputValues, deps, depVersions: deps.map((dep) => dep.getVersion()), result: value });
    if (cache.length > cacheMax) cache.length = cacheMax;
    forwardDeps(deps);
    warnIfOrphanedDeps(deps);
    return value;
  };
}
