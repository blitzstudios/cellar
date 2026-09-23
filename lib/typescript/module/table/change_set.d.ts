/**
 * What a write changed, in the units a store declares — a player, a team — rather than the rows behind them.
 *
 * The write is the only party that knows. A write that says only "this partition moved" leaves every reader to find
 * out for itself whether its part of it did; a write that reports its units lets a reader of an unchanged unit sleep
 * through it, and one that changed nothing lets every reader sleep.
 */
/** Every unit, for a write that cannot say which: a degraded store, a failed diff, a store bumping by hand. */
export declare const ALL_UNITS: "all";
/** The units a write changed, or {@link ALL_UNITS}. An empty set is a write that changed nothing. */
export type ChangeSet = typeof ALL_UNITS | ReadonlySet<string>;
/** What a row table write hands back: what it changed, and how many rows the payload held. */
export interface WriteResult {
    changes: ChangeSet;
    /** Rows the payload held, whether or not they changed anything; what ingest timing and the oversized report count. */
    rows: number;
}
/** The change set of a write that changed nothing. Frozen, so one shared instance cannot be mutated by a caller. */
export declare const NO_CHANGES: ReadonlySet<string>;
/** Whether a write changed nothing, which is the case a bump skips. */
export declare function isUnchanged(changes: ChangeSet): boolean;
/** Both writes' changes, for a caller making several — a push flushing in chunks. */
export declare function unionChanges(left: ChangeSet, right: ChangeSet): ChangeSet;
/** Whether a write touched any of `units`. Walks the smaller side, since a change set is usually a handful. */
export declare function touchesAny(changes: ChangeSet, units: ReadonlySet<string>): boolean;
//# sourceMappingURL=change_set.d.ts.map