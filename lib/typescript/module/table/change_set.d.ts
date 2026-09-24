/**
 * Change sets: what a write changed, as unit values rather than rows. A unit is all the rows in one partition that
 * share a value in the table's unit column, such as one player's rows; a write's change set is the unit value of each
 * row it added, changed or removed. Bumping a partition with its change set re-runs only the reads that depend on those
 * units (or on the whole partition), and an empty change set re-runs nothing.
 */
/**
 * A change set meaning every unit in the partition changed, for a write that can't say which units it changed, such as
 * a store bumping by hand. Bumping with it re-runs every read of the partition.
 */
export declare const ALL_UNITS: "all";
/**
 * What a write changed: the unit value (such as a `player_id`) of each row it added, changed or removed, or
 * {@linkcode ALL_UNITS} when every unit counts as changed. An empty set means the write changed nothing.
 */
export type ChangeSet = typeof ALL_UNITS | ReadonlySet<string>;
/** What a row table write returns: its change set, and how many rows it was given. */
export interface WriteResult {
    /**
     * The write's change set: the unit value (such as a `player_id`) of each row it added, changed or removed. Empty if
     * the rows matched what the table held.
     */
    changes: ChangeSet;
    /** How many rows the write was given, whether or not they changed anything. */
    rows: number;
}
/** The change set of a write that changed nothing: an empty set, frozen so it can be shared. */
export declare const NO_CHANGES: ReadonlySet<string>;
/** Whether a change set is empty (the write changed nothing), in which case bumping with it does nothing. */
export declare function isUnchanged(changes: ChangeSet): boolean;
/**
 * Combines the change sets of two writes into one (every unit either changed), such as the chunks of one push. If
 * either is {@linkcode ALL_UNITS}, so is the result.
 */
export declare function unionChanges(left: ChangeSet, right: ChangeSet): ChangeSet;
/** Whether a write touched any of `units`. Walks the smaller side, since a change set is usually a handful. */
export declare function touchesAny(changes: ChangeSet, units: ReadonlySet<string>): boolean;
//# sourceMappingURL=change_set.d.ts.map