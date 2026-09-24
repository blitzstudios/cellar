/**
 * A replacement for Reselect's `createSelector`, for a Redux selector that reads store data, usually by calling a
 * service in its `resultFn`. Reselect only re-runs when its inputs change, so it would keep a stale result after a
 * write. This one also re-runs when anything `resultFn` read from a store changes.
 */
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
/**
 * Creates a selector that calls `resultFn` with the values of `inputs`, caching the result per argument set until an
 * input changes or something `resultFn` read from a store changes. Call it inside a tracking scope, such as a
 * `useTrackedStores` component or a `useValue` hook; elsewhere its results are correct but a write re-renders nothing.
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