/** The per-partition version counter that stands in for change notification: a write bumps it, a reader watches it. */
import { DependencyList } from 'react';
/** Whether a part list addresses a real partition: at least one part, and every part filled in. */
export declare const isLive: (parts: readonly string[]) => boolean;
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
 * The change notification for a whole store, one integer per partition: a write bumps, a reactive reader subscribes
 * through `useVersion` / `useSelect`, and `get` reads imperatively while registering the partition with any active
 * tracking scope. A store is handed one by its spine and passes it to `definePartitions`.
 */
export interface VersionAtom {
    key(parts: readonly string[]): [string, string];
    /** 0 for a partition that has never been written. */
    get(parts: readonly string[]): number;
    bump(parts: readonly string[]): number;
    bumpAll(): void;
    subscribe(parts: readonly string[], listener: () => void): () => void;
    useVersion(parts: readonly string[], enabled?: boolean): number;
    useSelect<T>(parts: readonly string[], enabled: boolean, deps: DependencyList, compute: () => T, isEqual: (left: T, right: T) => boolean, empty: T): T;
    useSelectMany<T>(partsList: readonly (readonly string[])[], enabled: boolean, deps: DependencyList, compute: () => T, isEqual: (left: T, right: T) => boolean, empty: T): T;
}
/**
 * Builds the atom for one store, `root` naming it in the dependency ids its reads report. Its entries are module-level
 * and one per partition, so a write wakes every reader of that partition and no reader of any other.
 */
export declare function createVersionAtom(root: string): VersionAtom;
//# sourceMappingURL=version_atom.d.ts.map