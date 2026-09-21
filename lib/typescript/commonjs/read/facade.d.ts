/**
 * What a store service's public surface is written against: the small types its methods are spelled in, and the
 * reactive/imperative pair each read is published as.
 */
import type { Read, ReadCallOptions } from './surface';
import type { DataResult } from '../store_result';
/** An id a caller may not have yet; a read takes it directly and stays inert until it arrives. */
export type MaybeId = string | undefined | null;
/**
 * The `options` half of a facade read's single argument, intersected with the params — `{ params: P } & ReadOptions` is
 * the call shape every facade read is lint-checked for. It carries the per-call `enabled`, which turns a read off
 * (nothing fetched, `select` skipped, `empty` back) while the screen keeps calling the hook in the same position.
 */
export type ReadOptions = {
    options?: ReadCallOptions;
};
/** Optional *and* nullable, so a caller's own `string | null | undefined` passes straight through. */
export type Loose<T> = {
    [K in keyof T]?: T[K] | null;
};
/**
 * One read's two halves: `useValue` for a component, `getValue` for imperative code, reactive inside a tracking
 * scope. The reactive half keeps a `use` name, or React Compiler takes it for an ordinary call and memoizes it away.
 */
export interface PairedRead<Params, T> {
    useValue: (args: {
        params: Params;
    } & ReadOptions) => DataResult<T>;
    getValue: (args: {
        params: Params;
    }) => T;
}
/**
 * Publishes a read as its reactive and imperative halves, from a thunk resolving it on whichever backend is bound.
 * Params are the read's own args, loosely: the read's {@link Read.requires} says which of them it waits on, and it
 * stays inert until a caller has them all, so a service publishing it names nothing the store already declared.
 *
 * The halves return the same value but do not fetch alike, so swapping one for the other is not free. `useValue`
 * primes through React Query and refetches on its staleness; `getValue` fetches a partition that has never been
 * fetched and otherwise leaves it, because a one-shot call has no subscription for staleness to act on and a
 * getter in a loop would otherwise drive the network.
 */
export declare function pairRead<Args, T>(read: () => Read<Args, T>): PairedRead<Loose<Args>, T>;
//# sourceMappingURL=facade.d.ts.map