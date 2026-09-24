/**
 * How a store tells its readers about writes: a version number per partition, and the version at which each unit last
 * changed. A write bumps the units it changed; a reader depends on the units it read, or on the whole partition.
 */
import { ChangeSet } from '../table/change_set';
/** Whether key parts name a partition: at least one part, and none empty. */
export declare const addressesPartition: (parts: readonly string[]) => boolean;
/** An empty, shared list of key parts, for a hook that must still run while it names no partition. */
export declare const NO_PARTS: readonly string[];
/** A partition's key together with its key parts. */
export interface PartitionEntry<Key> {
    /** The partition's key. */
    key: Key;
    /** Its key parts. */
    parts: readonly string[];
}
/** Pairs each key with its key parts, in the same order, including keys that name no partition. */
export declare function partitionEntries<Key>(keys: readonly Key[], toParts: (key: Key) => readonly string[]): PartitionEntry<Key>[];
/**
 * A store's version numbers, which is how reads learn about writes. Each partition has three, and reading any of them
 * inside a tracking scope makes the derivation depend on it:
 *
 * - `get`: the partition's version, which changes on every write that changed anything. A read of the whole partition
 *   depends on it.
 * - `getUnit`: the version at which one unit last changed. A read of named units depends only on those, so a write to
 *   other units doesn't re-run it.
 * - `getPresence`: changes only when the partition may have gone from empty to having rows, or back: on its first
 *   write, and on any write that couldn't say which units it changed. A read checks it to know whether there is anything
 *   to select from.
 */
export interface VersionAtom {
    /** The partition's dependency id: the store's name and the partition's key. */
    key(parts: readonly string[]): [string, string];
    /** The partition's version; 0 if it has never been written. Tracked. */
    get(parts: readonly string[]): number;
    /** The version at which `unit` last changed; 0 if never. Tracked for that unit only. */
    getUnit(parts: readonly string[], unit: string): number;
    /**
     * A version that changes when the partition may have gone from empty to having rows, or back. Tracked for that only.
     */
    getPresence(parts: readonly string[]): number;
    /**
     * Records a write to the partition and notifies its readers, returning its new version. `changes` is the units the
     * write changed: every unit if omitted, and no change at all if empty.
     */
    bump(parts: readonly string[], changes?: ChangeSet): number;
    /** Bumps every partition written so far, with every unit changed. */
    bumpAll(): void;
    /** Calls `listener` on every write to the partition, returning an unsubscribe. */
    subscribe(parts: readonly string[], listener: () => void): () => void;
    /**
     * The partition's version as a hook, re-rendering on each write. While the component's read gate isn't live it keeps
     * the version it had, and catches up with one render when the gate is live again.
     */
    useVersion(parts: readonly string[], enabled?: boolean): number;
}
/** Creates a store's {@link VersionAtom}. `root` is the store's name, the first part of each dependency id. */
export declare function createVersionAtom(root: string): VersionAtom;
//# sourceMappingURL=version_atom.d.ts.map