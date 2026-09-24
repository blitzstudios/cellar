/**
 * The version atom: how a store's reads learn about its writes. It keeps a version number for each partition (the set
 * of rows one fetch returns and replaces), and the version at which each unit in it last changed (a unit is all the
 * rows sharing one value of the table's unit column, such as one player's rows).
 *
 * A write "bumps" the partition with the units it changed, which raises the numbers and notifies whoever is listening
 * to them. A read records which numbers it looked at, and re-runs when one of them moves: a read of named units only
 * when those units change, a read of the whole partition on any change.
 */
import { trackDependency } from './tracking';
import { ALL_UNITS, ChangeSet } from '../table/change_set';
import type { Read } from '../read/surface';
import type { defineSqliteStore } from '../define_sqlite_store';
/**
 * Whether a partition key's parts name an actual partition: at least one part, and none of them empty. A key built from
 * args that are still missing a value has an empty part, and reads and fetches nothing.
 */
export declare const addressesPartition: (parts: readonly string[]) => boolean;
/** An empty, shared list of key parts, for a hook that must still run while its args name no partition yet. */
export declare const NO_PARTS: readonly string[];
/** A partition's key together with its key parts (the key's values as a list of strings). */
export interface PartitionEntry<Key> {
    /** The partition's key, as the store defines it. */
    key: Key;
    /** The key's values as a list of strings, which identify the partition in the version atom and in query keys. */
    parts: readonly string[];
}
/**
 * Pairs each partition key with its key parts, in the same order. Keys that name no partition (from args still missing
 * a value) are kept, so positions still line up with the list of keys.
 */
export declare function partitionEntries<Key>(keys: readonly Key[], toParts: (key: Key) => readonly string[]): PartitionEntry<Key>[];
/**
 * A store's version numbers: how its reads learn about its writes. Every method takes a partition's key parts (the
 * partition key's values as a list of strings). A partition is the set of rows one fetch returns and replaces; a unit
 * is all the rows sharing one value of the table's unit column, such as one player's rows.
 *
 * Each partition has three numbers, and reading one inside a tracking scope (a {@linkcode Read.useValue | useValue}
 * read, `useTrackedStores`, a tracked selector) makes the scope depend on it, so the scope re-runs when it changes:
 *
 * - {@linkcode VersionAtom.get | get}: the partition's version, which goes up on every write that changes anything in
 *   it. A read of the whole partition depends on this.
 * - {@linkcode VersionAtom.getUnit | getUnit}: the version at which one unit last changed. A read of particular units
 *   depends on just those, so a write to other units doesn't re-run it.
 * - {@linkcode VersionAtom.getPresence | getPresence}: goes up only when the partition may have gone from empty to
 *   having rows, or back: on its first write, and on any write that couldn't say which units it changed. A read checks
 *   it to know whether there is anything to select from, without depending on every unit.
 */
export interface VersionAtom {
    /**
     * The partition's identity for dependency tracking: the store's name, and the partition's key parts joined into one
     * string.
     */
    key(parts: readonly string[]): [string, string];
    /**
     * The partition's version number: 0 before its first write, and one higher after every write that changes it.
     * Tracked: inside a tracking scope, the scope re-runs after any write that changes the partition.
     */
    get(parts: readonly string[]): number;
    /**
     * The version at which `unit` (a value of the unit column, such as a `player_id`) last changed in the partition, or 0
     * if it hasn't been written. Tracked for that unit only: inside a tracking scope, the scope re-runs only after a
     * write that changes that unit.
     */
    getUnit(parts: readonly string[], unit: string): number;
    /**
     * A number that goes up only when the partition may have gone from empty to having rows, or back. Tracked for that
     * only: inside a tracking scope, the scope re-runs on such a change, not on every write.
     */
    getPresence(parts: readonly string[]): number;
    /**
     * Records a write to the partition and notifies the readers it concerns, returning the partition's new version.
     * `changes` is the units the write changed (values of the unit column): readers of the whole partition and readers of
     * those units are notified, and readers of other units aren't. Omitted, or {@linkcode ALL_UNITS}, means every unit
     * changed. An empty set means nothing changed, and bumps nothing.
     */
    bump(parts: readonly string[], changes?: ChangeSet): number;
    /**
     * Bumps every partition the atom knows of (written, or listened to), with every unit changed, so every reader of the
     * store re-reads. Used when the store moves to a different database.
     */
    bumpAll(): void;
    /** Calls `listener` after every write that changes the partition, and returns a function that unsubscribes it. */
    subscribe(parts: readonly string[], listener: () => void): () => void;
    /**
     * The partition's version number as a hook, re-rendering the component after every write that changes the partition.
     * While the component's read gate isn't live (its screen is hidden, say), it keeps returning the version it had and
     * doesn't re-render; when the gate is live again, it re-renders once if the partition changed meanwhile. `enabled`
     * false returns 0 and subscribes to nothing.
     */
    useVersion(parts: readonly string[], enabled?: boolean): number;
}
/**
 * Creates a store's {@linkcode VersionAtom}: the version numbers, per partition and per unit, that its reads depend on
 * and its writes bump. `root` names the store in each partition's dependency identity. {@linkcode defineSqliteStore}
 * creates one per store.
 */
export declare function createVersionAtom(root: string): VersionAtom;
export type { ALL_UNITS, Read, defineSqliteStore, trackDependency };
//# sourceMappingURL=version_atom.d.ts.map