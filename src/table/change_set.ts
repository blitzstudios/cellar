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
export const ALL_UNITS = 'all' as const;

/**
 * What a write changed: the unit value (such as a `player_id`) of each row it added, changed or removed, or
 * {@link ALL_UNITS} when every unit counts as changed. An empty set means the write changed nothing.
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
export const NO_CHANGES: ReadonlySet<string> = Object.freeze(new Set<string>()) as ReadonlySet<string>;

/** Whether a change set is empty (the write changed nothing), in which case bumping with it does nothing. */
export function isUnchanged(changes: ChangeSet): boolean {
  return changes !== ALL_UNITS && changes.size === 0;
}

/**
 * Combines the change sets of two writes into one (every unit either changed), such as the chunks of one push. If
 * either is {@link ALL_UNITS}, so is the result.
 */
export function unionChanges(left: ChangeSet, right: ChangeSet): ChangeSet {
  if (left === ALL_UNITS || right === ALL_UNITS) return ALL_UNITS;
  if (!right.size) return left;
  if (!left.size) return right;
  const out = new Set(left);
  for (const unit of right) out.add(unit);
  return out;
}

/** Whether a write touched any of `units`. Walks the smaller side, since a change set is usually a handful. */
export function touchesAny(changes: ChangeSet, units: ReadonlySet<string>): boolean {
  if (changes === ALL_UNITS) return true;
  const [small, large] = changes.size <= units.size ? [changes, units] : [units, changes];
  for (const unit of small) if (large.has(unit)) return true;
  return false;
}
