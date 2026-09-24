/**
 * Dependency tracking: each version read (`version.get` and the like) reports what it read to the enclosing tracking
 * scope, which subscribes to it. A getter must do this on every call, cache hits included, or a derivation using it
 * won't update.
 */
/** Something a tracked read depended on: a partition, one unit of it, or its presence. */
export interface Dep {
    /** Identifies the dependency, so a scope can compare what it read against what it subscribed to last time. */
    id: string;
    /** Calls `listener` when it changes, returning an unsubscribe. */
    subscribe: (listener: () => void) => () => void;
    /** Its current version, for noticing a change between the read and the subscribe. */
    getVersion: () => number;
}
/**
 * Runs `fn`, marking its reads as already subscribed to by hand, which silences the dev warning about reading during
 * render without subscribing.
 */
export declare function runSubscribed<T>(fn: () => T): T;
/**
 * Reports a dependency to the enclosing tracking scope; this is how `version.get` makes a read visible to
 * {@link runTracked}. Outside any scope, in dev, a read during render that nothing subscribes to logs a warning naming
 * the partition and the component.
 */
export declare function trackDependency(dep: Dep): void;
/**
 * Runs `fn` in a tracking scope, returning its value and what it read, for a caller that subscribes to those itself,
 * such as `useTrackedStores`. An inner scope doesn't pass its dependencies to the outer one; call `trackDependency` on
 * each to forward them.
 */
export declare function runTracked<T>(fn: () => T): {
    /** What `fn` returned. */
    value: T;
    /** What `fn` read. */
    deps: Dep[];
};
/**
 * Whether a scope is collecting dependencies right now, for deciding whether a warning is warranted: deps collected
 * with nothing above them reach no subscriber. Not for branching real behaviour on — a read reports itself either way.
 */
export declare function isTracking(): boolean;
//# sourceMappingURL=tracking.d.ts.map