/** A store's memos, for a suite that builds one module of a store rather than the whole store. */
import { MemoFactory } from '../caches';
import { VersionAtom } from '../reactivity/version_atom';
import type { Partitions, definePartitions } from '../define_partitions';
/**
 * A {@linkcode Partitions.memos | memos} function like the one {@linkcode definePartitions} gives a store's modules,
 * for testing a module on its own. Pass the version atom the test bumps, or its memos won't see the writes.
 */
export declare function testMemos<Key = string>(version: VersionAtom, opts?: {
    /** The store name shown in warnings; `test` by default. */
    store?: string;
    /** A key's parts, for a key that isn't a single string. */
    parts?: (key: Key) => readonly string[];
}): MemoFactory<Key>;
export type { Partitions, definePartitions };
//# sourceMappingURL=memos.d.ts.map