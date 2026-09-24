/**
 * The hook behind every reactive read: it runs a derivation, subscribes to exactly what it read, and runs it again
 * when one of those changes.
 *
 * Dependencies are found by running the derivation, not declared: each unit, partition or presence it reads is
 * subscribed to. A read of three players subscribes to those three, so a write to a fourth doesn't re-run it. When the
 * derivation reads something different next time, the subscriptions change to match.
 */
import { DependencyList } from 'react';
/** Options for {@link useTrackedValue}. */
export interface TrackedValueOptions<T> {
    /** When false, the hook returns `empty` and subscribes to nothing. */
    enabled: boolean;
    /**
     * Compares a recomputed value with the previous one; when equal, the previous object is kept and nothing re-renders.
     */
    isEqual: (left: T, right: T) => boolean;
    /** What the hook returns while disabled. */
    empty: T;
    /**
     * Another source of changes to re-run on, such as Redux for a derivation that also reads it. Returns an unsubscribe.
     */
    subscribeExtra?: (notify: () => void) => () => void;
}
/**
 * Runs `compute`, subscribes to what it read, and re-renders with a new value when any of that changes. `inputs` are
 * the values `compute` uses, such as the read's args; a change in them also re-runs it.
 *
 * While the component's read gate isn't live, it unsubscribes and keeps its last value, so a hidden screen doesn't
 * re-render. When the gate is live again, it re-renders once if anything changed meanwhile.
 */
export declare function useTrackedValue<T>(compute: () => T, inputs: DependencyList, options: TrackedValueOptions<T>): T;
//# sourceMappingURL=tracked_value.d.ts.map