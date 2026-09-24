/**
 * What a write changed, as a set of units (a player, a team) rather than rows. Only the write knows this: reporting it
 * lets readers of unchanged units skip the write, and a write that changed nothing wake no one.
 */
/** Stands for every unit, for a write that can't say which units it changed, such as a store bumping by hand. */
export declare const ALL_UNITS: "all";
/** The units a write changed, or {@link ALL_UNITS}. An empty set means the write changed nothing. */
export type ChangeSet = typeof ALL_UNITS | ReadonlySet<string>;
/** What a table write returns. */
export interface WriteResult {
    /** The units it changed. */
    changes: ChangeSet;
    /** How many rows it wrote, changed or not. */
    rows: number;
}
/** An empty, frozen {@link ChangeSet}, for a write that changed nothing. */
export declare const NO_CHANGES: ReadonlySet<string>;
/** Whether a write changed nothing, which is the case a bump skips. */
export declare function isUnchanged(changes: ChangeSet): boolean;
/** The units changed by either of two writes, such as two chunks of one push flush. */
export declare function unionChanges(left: ChangeSet, right: ChangeSet): ChangeSet;
/** Whether a write touched any of `units`. Walks the smaller side, since a change set is usually a handful. */
export declare function touchesAny(changes: ChangeSet, units: ReadonlySet<string>): boolean;
//# sourceMappingURL=change_set.d.ts.map