/**
 * The change notification for a store: one counter per partition, and beneath it the version each unit last changed
 * at. A write bumps with the units it changed; a reader depends on the units it read, or on the whole partition.
 */
import { ChangeSet } from '../table/change_set';
/** Whether a part list addresses a real partition: at least one part, and every part filled in. */
export declare const addressesPartition: (parts: readonly string[]) => boolean;
/** Stable empty part list, for a hook that must run in the same position while addressing nothing. */
export declare const NO_PARTS: readonly string[];
/** A partition key paired with the parts it is keyed by, for a caller needing both over a set of them — a presence probe across a `readMany`. */
export interface PartitionEntry<Key> {
    key: Key;
    parts: readonly string[];
}
/** Each key paired with its parts, gaps included, so the result stays parallel with the keys named. */
export declare function partitionEntries<Key>(keys: readonly Key[], toParts: (key: Key) => readonly string[]): PartitionEntry<Key>[];
/**
 * The change notification for a whole store. Three things can be depended on for each partition, and each reports
 * itself to an active tracking scope when read:
 *
 * - `get` — the partition's version, which moves on every write that changed anything. A read over the whole partition
 *   depends on this.
 * - `getUnit` — the version one unit last changed at. A read of named units depends on these alone, so a write that
 *   changed other units leaves it asleep.
 * - `getPresence` — which moves only when the partition may have gained or lost rows altogether: its first write, and
 *   any write that could not say which units it changed. Whether a partition holds rows at all is what gates a read.
 */
export interface VersionAtom {
    key(parts: readonly string[]): [string, string];
    /** 0 for a partition that has never been written. Tracks the partition. */
    get(parts: readonly string[]): number;
    /** The version `unit` last changed at, 0 if never. Tracks that unit alone. */
    getUnit(parts: readonly string[], unit: string): number;
    /** Moves when the partition may have gone from empty to holding rows, or back. Tracks presence alone. */
    getPresence(parts: readonly string[]): number;
    /** Raises the partition's version for a write that changed `changes`; every unit when omitted, nothing for none. */
    bump(parts: readonly string[], changes?: ChangeSet): number;
    bumpAll(): void;
    /** Listens for every write to the partition. */
    subscribe(parts: readonly string[], listener: () => void): () => void;
    useVersion(parts: readonly string[], enabled?: boolean): number;
}
/** Builds the atom for one store, `root` naming it in the dependency ids its reads report. */
export declare function createVersionAtom(root: string): VersionAtom;
//# sourceMappingURL=version_atom.d.ts.map