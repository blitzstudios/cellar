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
/** Called by every row table read. */
export declare function noteTableRead(): void;
/** Runs `read` as one whose dependencies are reported by its caller, so its table reads do not count as uncovered. */
export declare function covered<T>(read: () => T): T;
/** A running count of uncovered table reads: compare it before and after a derivation to learn whether it made one. */
export declare function uncoveredReads(): number;
//# sourceMappingURL=read_coverage.d.ts.map