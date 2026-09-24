/**
 * What a store service's public surface is written against: the small types its methods are spelled in, and the
 * reactive/imperative pair each read is published as.
 */
import type { Read, ReadCallOptions } from './surface';
import type { DataResult } from '../store_result';
/** An id a caller may not have yet. A read accepts it as is, and returns `empty` until it has a value. */
export type MaybeId = string | undefined | null;
/** The `options` part of a published read's argument, `{ params, options }`. */
export type ReadOptions = {
    /** This caller's read options, such as `enabled: false` to turn the read off while keeping the hook mounted. */
    options?: ReadCallOptions;
};
/** `T` with every field optional and nullable, so a caller can pass its own `string | null | undefined` as is. */
export type Loose<T> = {
    [K in keyof T]?: T[K] | null;
};
/**
 * A read as a service publishes it: a hook for components and a getter for other code. The hook is named with `use`
 * so React Compiler treats it as a hook rather than memoizing the call away.
 */
export interface PairedRead<Params, T> {
    /** The read as a hook: fetches if needed and re-renders when the value changes. */
    useValue: (args: {
        /** The read's args. */
        params: Params;
    } & ReadOptions) => DataResult<T>;
    /**
     * The read's current value, starting a fetch if the partition has never been fetched. Tracked: a derivation that
     * calls it re-runs when the value changes.
     */
    getValue: (args: {
        /** The read's args. */
        params: Params;
    }) => T;
}
/**
 * Publishes a store read as a hook and a getter, for a service's public API. `read` returns the read from the store,
 * and is called on every use so it always reaches the store's current table. Params are the read's args with every
 * field optional; the read returns `empty` until every field in its {@link Read.requires} has a value.
 *
 * The two return the same value but fetch differently. `useValue` fetches through React Query and refetches when the
 * data goes stale; `getValue` only fetches a partition that has never been fetched, since a one-off call has nothing
 * to refetch for, and a getter called in a loop would otherwise flood the network.
 */
export declare function pairRead<Args, T>(read: () => Read<Args, T>): PairedRead<Loose<Args>, T>;
//# sourceMappingURL=facade.d.ts.map