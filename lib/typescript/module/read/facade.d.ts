/**
 * The types a store's service (its public API, such as `playerService`) is written with, and `pairRead`, which
 * publishes each of a store's reads as a hook and a getter taking one `{ params, options }` argument.
 */
import type { Read, ReadCallOptions } from './surface';
import type { DataResult } from '../store_result';
/**
 * An id a caller may not have yet, such as a route param still loading. A published read accepts it as is, and returns
 * `empty` until it has a value (`undefined`, `null` and `''` count as not having one).
 */
export type MaybeId = string | undefined | null;
/** The `options` part of a published read hook's argument, `{ params, options }`. */
export type ReadOptions = {
    /**
     * Options for this call only: `enabled: false` turns the read off (it returns `empty` and fetches nothing) while the
     * hook stays in place, and `prime: false` reads without fetching, for a component whose parent fetches.
     */
    options?: ReadCallOptions;
};
/**
 * `T` with every field optional and nullable. A published read takes its params this way, so a caller can pass values
 * it may not have yet (`string | null | undefined`) as they are, and the read returns `empty` until they arrive.
 */
export type Loose<T> = {
    [K in keyof T]?: T[K] | null;
};
/**
 * A store read as a service publishes it (from {@link pairRead}): a hook for components and a getter for other code,
 * which return the same value. The hook is named with `use` so React Compiler treats it as a hook rather than
 * memoizing the call away.
 */
export interface PairedRead<Params, T> {
    /**
     * The read as a hook: fetches its partition if it hasn't been fetched or is stale, returns the value with the fetch's
     * state as a `DataResult`, and re-renders the component when the value changes. Returns `empty` until every field the
     * read requires has a value.
     */
    useValue: (args: {
        /**
         * The read's args. Every field is optional and nullable; the read returns `empty` until the fields it needs arrive.
         */
        params: Params;
    } & ReadOptions) => DataResult<T>;
    /**
     * The read's current value, for code outside a component. Starts a fetch if the partition has never been fetched (but
     * doesn't refetch a stale one), and returns `empty` until it has rows. Tracked: inside a tracking scope (a `useValue`
     * read, `useTrackedStores`, a tracked selector), the scope re-runs when the value changes.
     */
    getValue: (args: {
        /**
         * The read's args. Every field is optional and nullable; the read returns `empty` until the fields it needs arrive.
         */
        params: Params;
    }) => T;
}
/**
 * Publishes a store read as a hook (`useValue`) and a getter (`getValue`) for a service's public API, each taking one
 * `{ params }` argument. `read` returns the read from the store, such as `() => playerStore.reads.byId`; it is called
 * on every use, so it always reaches the read built over the store's current database. The params are the read's args
 * with every field optional and nullable, and both return `empty` until every field in the read's
 * {@link Read.requires} has a value (`undefined`, `null` and `''` count as missing).
 *
 * The two return the same value but fetch differently. `useValue` fetches through React Query, and refetches when the
 * partition is older than its `staleTime`. `getValue` fetches only a partition that has never been fetched: a one-off
 * call has no component to refresh, and a getter called in a loop would otherwise flood the network.
 */
export declare function pairRead<Args, T>(read: () => Read<Args, T>): PairedRead<Loose<Args>, T>;
//# sourceMappingURL=facade.d.ts.map