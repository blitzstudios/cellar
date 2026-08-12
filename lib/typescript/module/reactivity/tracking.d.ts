/**
 * Off-heap dependency tracking: `version.get` reports each partition it reads to the active scope. INVARIANT: an
 * imperative getter must call it on every call, cache hits included, or its tracked consumer is silently stale.
 */
/**
 * One partition a tracked read touched, carrying what a consumer needs to watch it: an id to compare against the
 * partitions it watched last time, a subscription, and the version, so a bump between the read and the subscribe is
 * caught rather than missed.
 */
export interface Dep {
    id: string;
    subscribe: (listener: () => void) => () => void;
    getVersion: () => number;
}
/** Marks reads inside `fn` as covered by an explicit subscription, exempting them from the render guard. */
export declare function runSubscribed<T>(fn: () => T): T;
/**
 * Reports a partition to whatever scope is tracking, which is how `version.get` makes a read visible to
 * {@link runTracked}. With no scope above it, this is the DEV guard instead: a read during render that nothing has
 * subscribed warns, naming the partition and the component.
 */
export declare function trackDependency(dep: Dep): void;
/**
 * Runs `fn` and hands back its value together with the partitions it read, for a consumer that subscribes to them
 * itself — `useTrackedStores` and `createTrackedSelector`. Scopes nest, and an inner one keeps its deps to itself, so a
 * scope inside another forwards them outward with `trackDependency` if it wants the outer one subscribed too.
 */
export declare function runTracked<T>(fn: () => T): {
    value: T;
    deps: Dep[];
};
/**
 * Whether a scope is collecting dependencies right now, for deciding whether a warning is warranted: deps collected
 * with nothing above them reach no subscriber. Not for branching real behaviour on — a read reports itself either way.
 */
export declare function isTracking(): boolean;
//# sourceMappingURL=tracking.d.ts.map