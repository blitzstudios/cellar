/**
 * The hook every reactive read goes through: run a derivation, subscribe to exactly what it read, and run it again
 * when one of those things changes.
 *
 * What a derivation depends on is found by running it, not declared: every version it reads reports itself to the
 * tracking scope this opens — a unit it named, a partition it scanned, a partition's presence — and those are what the
 * component subscribes to. A read of three players subscribes to three players, and a write that changed a fourth
 * leaves it asleep. When the derivation reads something different next time, the subscriptions follow.
 */
import { DependencyList } from 'react';
export interface TrackedValueOptions<T> {
    /** A disabled read returns `empty` and subscribes to nothing. */
    enabled: boolean;
    /** Decides whether a recomputed value replaces the previous one; an equal value keeps the old reference and render. */
    isEqual: (left: T, right: T) => boolean;
    empty: T;
    /** Another source of change to listen to beside the tracked dependencies, for a derivation that also reads Redux. */
    subscribeExtra?: (notify: () => void) => () => void;
}
/**
 * Runs `compute` and subscribes to what it read. `inputs` is what `compute` closes over — the read's args — and a
 * change in them runs it again whether or not anything it read moved.
 *
 * The host's read gate applies: while it is closed the subscriptions are dropped and the value is held, so a screen
 * nobody is looking at does not repaint, and when it reopens one render catches up — only if something moved.
 */
export declare function useTrackedValue<T>(compute: () => T, inputs: DependencyList, options: TrackedValueOptions<T>): T;
//# sourceMappingURL=tracked_value.d.ts.map