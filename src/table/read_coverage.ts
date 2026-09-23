/**
 * Whether a read touched the table somewhere nothing reported what it read.
 *
 * A read's dependencies are found by running it: a projection or a unit memo reports the units it read, a partition
 * memo reports the partition. A `select` that reads rows straight off the table reports nothing, and if it also read
 * one unit memo, it would look as though it depended on that unit alone. So every table read counts itself here unless
 * it runs inside {@link covered} — which the kernel's own reporting constructs wrap their reads in — and a read that
 * made an uncovered table read is made to depend on its whole partition. A store can lose precision this way, never
 * correctness.
 */

let covering = 0;
let uncovered = 0;

/** Called by every row table read. */
export function noteTableRead(): void {
  if (!covering) uncovered += 1;
}

/** Runs `read` as one whose dependencies are reported by its caller, so its table reads do not count as uncovered. */
export function covered<T>(read: () => T): T {
  covering += 1;
  try {
    return read();
  } finally {
    covering -= 1;
  }
}

/** A running count of uncovered table reads: compare it before and after a derivation to learn whether it made one. */
export function uncoveredReads(): number {
  return uncovered;
}
