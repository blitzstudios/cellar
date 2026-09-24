"use strict";

/**
 * What a write changed, as a set of units (a player, a team) rather than rows. Only the write knows this: reporting it
 * lets readers of unchanged units skip the write, and a write that changed nothing wake no one.
 */

/** Stands for every unit, for a write that can't say which units it changed, such as a store bumping by hand. */
export const ALL_UNITS = 'all';

/** The units a write changed, or {@link ALL_UNITS}. An empty set means the write changed nothing. */

/** What a table write returns. */

/** An empty, frozen {@link ChangeSet}, for a write that changed nothing. */
export const NO_CHANGES = Object.freeze(new Set());

/** Whether a write changed nothing, which is the case a bump skips. */
export function isUnchanged(changes) {
  return changes !== ALL_UNITS && changes.size === 0;
}

/** The units changed by either of two writes, such as two chunks of one push flush. */
export function unionChanges(left, right) {
  if (left === ALL_UNITS || right === ALL_UNITS) return ALL_UNITS;
  if (!right.size) return left;
  if (!left.size) return right;
  const out = new Set(left);
  for (const unit of right) out.add(unit);
  return out;
}

/** Whether a write touched any of `units`. Walks the smaller side, since a change set is usually a handful. */
export function touchesAny(changes, units) {
  if (changes === ALL_UNITS) return true;
  const [small, large] = changes.size <= units.size ? [changes, units] : [units, changes];
  for (const unit of small) if (large.has(unit)) return true;
  return false;
}
//# sourceMappingURL=change_set.js.map