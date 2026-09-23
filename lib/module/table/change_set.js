"use strict";

/**
 * What a write changed, in the units a store declares — a player, a team — rather than the rows behind them.
 *
 * The write is the only party that knows. A write that says only "this partition moved" leaves every reader to find
 * out for itself whether its part of it did; a write that reports its units lets a reader of an unchanged unit sleep
 * through it, and one that changed nothing lets every reader sleep.
 */

/** Every unit, for a write that cannot say which: a degraded store, a failed diff, a store bumping by hand. */
export const ALL_UNITS = 'all';

/** The units a write changed, or {@link ALL_UNITS}. An empty set is a write that changed nothing. */

/** What a row table write hands back: what it changed, and how many rows the payload held. */

/** The change set of a write that changed nothing. Frozen, so one shared instance cannot be mutated by a caller. */
export const NO_CHANGES = Object.freeze(new Set());

/** Whether a write changed nothing, which is the case a bump skips. */
export function isUnchanged(changes) {
  return changes !== ALL_UNITS && changes.size === 0;
}

/** Both writes' changes, for a caller making several — a push flushing in chunks. */
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