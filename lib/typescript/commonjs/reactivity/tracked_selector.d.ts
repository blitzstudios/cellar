/**
 * A stand-in for Reselect's `createSelector`, for a Redux selector that reaches into off-heap data — usually by
 * calling a service inside its `resultFn`. Reselect memoizes on the declared inputs alone, so such a selector holds
 * its old result after a partition is written and the screen never repaints. This one records the partitions the
 * `resultFn` touched and treats them as inputs as well.
 */
/** One entry in the `inputs` array: takes the selector's own arguments and returns a value `resultFn` receives. */
export type InputSelector<Args extends readonly unknown[], T = unknown> = (...args: Args) => T;
/** Decides whether an input is unchanged and a memoized result may stand. */
export type EqualityFn = (left: unknown, right: unknown) => boolean;
/** {@link createTrackedSelector}'s third argument: how its inputs are compared, how much it remembers, and what to call it in a warning. */
export interface TrackedSelectorOptions {
    /** Defaults to `Object.is`. Pass a deep or shallow compare for inputs rebuilt on every call. */
    inputEqual?: EqualityFn;
    /** Names this selector in the DEV warning about reads made outside a tracking scope. */
    debugLabel?: string;
    /** How many argument sets to memoize at once. Defaults to 8. */
    cacheMax?: number;
}
/**
 * Builds a selector calling `resultFn` with the values of `inputs`, memoized per argument set and recomputed when
 * an input changes or a partition `resultFn` read is written. The consumer must be inside a tracking scope — a
 * `useTrackedStores` component or a `useValue` hook — or the result is correct but nothing repaints on a write.
 */
export declare function createTrackedSelector<Args extends readonly unknown[], V1, R>(inputs: readonly [InputSelector<Args, V1>], resultFn: (v1: V1) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, R>(inputs: readonly [InputSelector<Args, V1>, InputSelector<Args, V2>], resultFn: (v1: V1, v2: V2) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, R>(inputs: readonly [InputSelector<Args, V1>, InputSelector<Args, V2>, InputSelector<Args, V3>], resultFn: (v1: V1, v2: V2, v3: V3) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, R>(inputs: readonly [InputSelector<Args, V1>, InputSelector<Args, V2>, InputSelector<Args, V3>, InputSelector<Args, V4>], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, R>(inputs: readonly [InputSelector<Args, V1>, InputSelector<Args, V2>, InputSelector<Args, V3>, InputSelector<Args, V4>, InputSelector<Args, V5>], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, R>(inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>
], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, R>(inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
    InputSelector<Args, V7>
], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, V8, R>(inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
    InputSelector<Args, V7>,
    InputSelector<Args, V8>
], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7, v8: V8) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, V8, V9, R>(inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
    InputSelector<Args, V7>,
    InputSelector<Args, V8>,
    InputSelector<Args, V9>
], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7, v8: V8, v9: V9) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, R>(inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
    InputSelector<Args, V7>,
    InputSelector<Args, V8>,
    InputSelector<Args, V9>,
    InputSelector<Args, V10>
], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7, v8: V8, v9: V9, v10: V10) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, R>(inputs: readonly [
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
    InputSelector<Args, V11>
], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7, v8: V8, v9: V9, v10: V10, v11: V11) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12, R>(inputs: readonly [
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
    InputSelector<Args, V12>
], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7, v8: V8, v9: V9, v10: V10, v11: V11, v12: V12) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
//# sourceMappingURL=tracked_selector.d.ts.map