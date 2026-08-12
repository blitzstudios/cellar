/**
 * Bounded caches for values derived from off-heap rows. A version key answers without a query but misses on every
 * write to the partition; a source key survives that miss and keeps the reference when the rows behind it are
 * unchanged. {@link createVersionedSourceCache} carries both, which is what a value feeding an identity comparison
 * downstream wants. A store reaches these through {@link declareMemos}, which is where it accounts for all of them
 * at once.
 */
/** What a declared memo calls itself in a report, and what its keys are built from. */
export interface MemoDiagnostics {
    name: string;
    keyedBy: string;
}
/**
 * A fixed-capacity string-keyed map that drops its coldest entry when full: what every cache in this file is built on,
 * and what a store reaches for to bound a table it keys itself — interned partition records, per-partition timestamps.
 */
export interface BoundedLru<V> {
    /** `undefined` for a missing key and for a stored `undefined` alike; wrap the payload to tell them apart. */
    get(key: string): V | undefined;
    set(key: string, value: V): void;
    /** Least- to most-recently used. */
    keys(): IterableIterator<string>;
}
/** Builds one holding at most `max` entries. `onEvict` fires for a key dropped for capacity, which is how a cache notices it is undersized. */
export declare function createBoundedLru<V>(max: number, onEvict?: (key: string) => void): BoundedLru<V>;
/**
 * A memo over values derived from a partition's rows, held against that partition's version, so a read no write
 * invalidated answers from the entry instead of querying the table again. An `isEqual` on top hands back the prior
 * reference when a recompute turned out to change nothing, so a downstream shallow-equal bails and nothing repaints.
 */
export interface VersionedCache<V> {
    /** The value held for `key` at `version`, computed on a miss. */
    read(key: string, version: number, compute: () => V): V;
    /** The entry held for `key` at `version`, wrapped so a stored `undefined` reads as a hit. */
    peek(key: string, version: number): {
        value: V;
    } | undefined;
    /** Stores `value` and returns the reference to use, which `isEqual` may make a prior one. */
    set(key: string, version: number, value: V): V;
}
/** Builds one. Stores declare theirs through {@link declareMemos}; the read surface holds its own two directly. */
export declare function createVersionedCache<V>(maxEntries: number, isEqual?: (prev: V, next: V) => boolean, diagnostics?: MemoDiagnostics): VersionedCache<V>;
/**
 * A value held against both its partition's version and its own source: the version answers without touching the
 * table at all, and the source keeps the reference when a bump turns out not to have changed these particular rows.
 */
export interface VersionedSourceCache<V> {
    /** The value held for `key`, if it was stored at `version`; a hit needs no query. */
    peek(key: string, version: number): {
        value: V;
    } | undefined;
    /** Records the value for `key` at `version`, building it only when `source` differs from the one held. */
    put(key: string, version: number, source: unknown, build: () => V): V;
}
/** `source` is compared with `Object.is`, so it must be a primitive or already reference-stable. */
export declare function createVersionedSourceCache<V>(maxEntries: number, diagnostics: MemoDiagnostics): VersionedSourceCache<V>;
/** A memo declared in a {@link declareMemos} block. {@link byVersion} and {@link bySource} are the two that exist. */
interface MemoDecl<C> {
    keyedBy: string;
    build(diagnostics: MemoDiagnostics): C;
}
/**
 * A memo dropped by every write to its partition. Reach for it when several reads derive the same value from a
 * partition's rows, or when one read consults it once per item: a memo keyed the way a single read is keyed holds
 * only what that read's own memo already holds.
 */
export declare function byVersion<V>(spec: {
    max: number;
    keyedBy: string;
    isEqual?: (prev: V, next: V) => boolean;
}): MemoDecl<VersionedCache<V>>;
/**
 * A memo that outlives the write a version-keyed one is dropped by, because it compares the rows behind the value.
 * Reach for it when the value feeds an identity comparison downstream and a bump elsewhere in the partition should
 * not repaint its readers.
 */
export declare function bySource<V>(spec: {
    max: number;
    keyedBy: string;
}): MemoDecl<VersionedSourceCache<V>>;
/**
 * Every memo a store holds, declared in one block: what each keeps, how many of them, and what a key is built from.
 * This is the only way a store builds one, so the block is a complete account of what it derives onto the heap.
 */
export declare function declareMemos<D extends Record<string, MemoDecl<unknown>>>(store: string, decls: D): {
    [K in keyof D]: D[K] extends MemoDecl<infer C> ? C : never;
};
/**
 * The `isEqual` for a read handing back a record of reference-stable values, which a hydration's map of VMs by id is:
 * a rebuilt map whose entries are the same references is not a change, so its readers do not repaint.
 */
export declare function shallowEqualRecord<V>(left: Record<string, V>, right: Record<string, V>): boolean;
/**
 * The `isEqual` for a read handing back a struct: every field compared with `Object.is`, except the ones named in
 * `deep`, which carry their own check. A scalar field added to `T` is covered without touching the call, and one
 * holding a freshly built object reads as a change until it is named here — the safe direction, since the cost of
 * that is a repaint rather than a stale value.
 */
export declare function shallowEqualStruct<T extends object>(deep: {
    [K in keyof T]?: (left: T[K], right: T[K]) => boolean;
}): (left: T, right: T) => boolean;
/** The same `isEqual` for a read handing back a list: a re-run that produced the same values in the same order is not a change. */
export declare function shallowEqualArray<V>(left: readonly V[], right: readonly V[]): boolean;
export {};
//# sourceMappingURL=caches.d.ts.map