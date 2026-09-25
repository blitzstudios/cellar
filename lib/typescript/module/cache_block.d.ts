/**
 * A store's cache block: every value the store keeps on the heap beyond its rows, declared together through its
 * partitions ({@linkcode Partitions.cache | cache}). Each entry is one of two kinds, named for what a write discards:
 * a {@linkcode byUnit} cache holds one value per unit and rebuilds only the units a write changed, and a
 * {@linkcode byVersion} cache holds values computed from a whole partition and discards them on any write to it.
 * Nothing here fetches: every value is built from rows already in the table.
 */
import { Memo, MemoDecl, PartitionBinding } from './caches';
import { DerivedValues, UnitCacheDeclaration } from './read/derived_values';
import { RowShape, RowTable } from './table/types';
import type { byUnit } from './read/derived_values';
import type { byVersion } from './caches';
import type { Partitions } from './define_partitions';
/**
 * One entry of a store's {@linkcode Partitions.cache | cache} block: a {@linkcode byVersion} cache, or, where the rows
 * are known, a {@linkcode byUnit} cache.
 */
export type CacheDeclaration<Row extends RowShape = never> = MemoDecl<unknown> | ([Row] extends [never] ? never : UnitCacheDeclaration<Row, any>);
/**
 * What a {@linkcode Partitions.cache | cache} block returns: one cache per entry, under the entry's key. A
 * {@linkcode byUnit} entry becomes {@linkcode DerivedValues}; a {@linkcode byVersion} entry becomes a cache read through
 * `.for(key)`.
 */
export type BoundCaches<Key, Row extends RowShape, D> = {
    [K in keyof D]: D[K] extends UnitCacheDeclaration<any, infer V> ? DerivedValues<Key, Row, V> : D[K] extends MemoDecl<infer Bound> ? Memo<Key, Bound> : never;
};
/**
 * A store's {@linkcode Partitions.cache | cache} function, which attaches a block of cache declarations to the store's
 * partitions. A store passes it to modules that declare their own caches, such as a ranker, so every cache the store
 * holds is attached the same way. Without the store's row type, it takes only {@linkcode byVersion} caches.
 */
export type CacheFactory<Key, Row extends RowShape = never> = <D extends Record<string, CacheDeclaration<Row>>>(decls: D) => BoundCaches<Key, Row, D>;
/** What a {@linkcode byUnit} cache reads its rows through: the store's table, and how a partition key addresses it. */
export interface UnitCacheSource<Row extends RowShape, Key> {
    table: RowTable<Row>;
    /** The column values that pick out a partition's rows. */
    filter: (key: Key) => Partial<Row>;
    /** Makes the calling read depend on the whole partition, for a lookup whose units any write can change. */
    trackPartition: (key: Key) => void;
}
/**
 * Attaches a cache block to a store: each {@linkcode byVersion} entry to the partitions' versions, and each
 * {@linkcode byUnit} entry to the rows `source` reads as well. Without a `source`, a {@linkcode byUnit} entry throws.
 */
export declare function bindCaches<Key, Row extends RowShape, D extends Record<string, CacheDeclaration<Row>>>(store: string, binding: PartitionBinding<Key>, decls: D, source?: UnitCacheSource<Row, Key>): BoundCaches<Key, Row, D>;
export type { Partitions, byUnit, byVersion };
//# sourceMappingURL=cache_block.d.ts.map