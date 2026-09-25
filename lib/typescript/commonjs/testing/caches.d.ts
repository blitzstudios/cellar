/** A store's cache block, for a suite that builds one module of a store rather than the whole store. */
import { CacheFactory } from '../cache_block';
import { VersionAtom } from '../reactivity/version_atom';
import type { Partitions, definePartitions } from '../define_partitions';
import type { byUnit, byVersion } from '../cache_block';
/**
 * A {@linkcode Partitions.cache | cache} function like the one {@linkcode definePartitions} gives a store's modules,
 * for testing a module on its own. It takes {@linkcode byVersion} caches only, since a {@linkcode byUnit} cache reads a
 * store's rows. Pass the version atom the test bumps, or its caches won't see the writes.
 */
export declare function testCache<Key = string>(version: VersionAtom, opts?: {
    /** The store name shown in warnings; `test` by default. */
    store?: string;
    /** A key's parts, for a key that isn't a single string. */
    parts?: (key: Key) => readonly string[];
}): CacheFactory<Key>;
export type { Partitions, byUnit, byVersion, definePartitions };
//# sourceMappingURL=caches.d.ts.map