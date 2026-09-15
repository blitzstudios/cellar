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
    /**
     * Whether the entry for `key` was built from this same `source`, ignoring what version it was stored at.
     *
     * This is what `put` is about to decide, asked ahead of calling it. A caller that must gather the inputs for
     * several keys in one query needs to know which of them will actually rebuild *before* it queries, or it ends up
     * fetching inputs for every key it holds and throwing away all but the few that moved.
     *
     * Treat the answer as a prediction, not a guarantee: the entry can still be evicted before `put` reaches it, so a
     * caller that used this to decide what to fetch must stay correct when a build it did not expect asks for inputs
     * it did not gather.
     */
    holds(key: string, source: unknown): boolean;
    /** Records the value for `key` at `version`, building it only when `source` differs from the one held. */
    put(key: string, version: number, source: unknown, build: () => V): V;
}
/** `source` is compared with `Object.is`, so it must be a primitive or already reference-stable. */
export declare function createVersionedSourceCache<V>(maxEntries: number, diagnostics: MemoDiagnostics): VersionedSourceCache<V>;
/**
 * What a memo's key holds beyond the partition: a scalar, or a structured value — a config object, an options subset —
 * which the kernel interns into a short id, so keying by one costs a key the length of an id rather than of its JSON.
 */
export type MemoPart = string | number | boolean | null | undefined | readonly unknown[] | Record<string, unknown>;
/**
 * What a source-keyed memo compares to decide whether the rows behind a value changed: one reference-stable value,
 * compared with `Object.is`, or a list of scalars, which the kernel folds into one string so the caller does not pick
 * a separator that a value could itself contain.
 */
export type MemoSource = object | string | number | boolean | null | undefined | readonly (string | number | null | undefined)[];
/** One `MemoPart` per name the memo declared in `by`, in that order. */
type PartsOf<By extends readonly string[]> = {
    -readonly [Index in keyof By]: MemoPart;
};
/** A memo bound to one partition, so neither its key nor its version is the caller's to build. */
export interface BoundVersionMemo<V, By extends readonly string[]> {
    /** The value held for these parts at the partition's current version, computed on a miss. */
    read(...args: [...PartsOf<By>, build: () => V]): V;
    /** The entry held for these parts, wrapped so a stored `undefined` reads as a hit. */
    peek(...parts: PartsOf<By>): {
        value: V;
    } | undefined;
    /** Stores a value and returns the reference to use, which `isEqual` may make a prior one. */
    set(...args: [...PartsOf<By>, value: V]): V;
}
/** The same, for a memo that outlives a version bump by comparing what the value was built from. */
export interface BoundSourceMemo<V, By extends readonly string[]> {
    peek(...parts: PartsOf<By>): {
        value: V;
    } | undefined;
    /**
     * Whether these parts already hold a value built from this `source`, and so will not rebuild.
     *
     * For deciding what to query before querying it. A bump drops every `peek`, so a read that consults this memo once
     * per item sees every item miss, and without this it must gather inputs for all of them to serve the few whose
     * source actually moved. See the note on {@link VersionedSourceCache.holds} about treating it as a prediction.
     */
    holds(...args: [...PartsOf<By>, source: MemoSource]): boolean;
    /** Records the value for these parts, building it only when `source` differs from the one held. */
    put(...args: [...PartsOf<By>, source: MemoSource, build: () => V]): V;
}
/** A declared memo, reached by naming the partition it holds values for. */
export interface Memo<Key, Bound> {
    for(key: Key): Bound;
}
/** A memo as declared, before a store's partitions bind it. {@link byVersion} and {@link bySource} are the two. */
interface MemoDecl<Bound> {
    by: readonly string[];
    bind(store: PartitionBinding<unknown>, diagnostics: MemoDiagnostics): Memo<unknown, Bound>;
}
/** What a `memos` block's entries are, whatever they hold: what {@link byVersion} and {@link bySource} return. */
export type MemoDeclaration = MemoDecl<unknown>;
/** What a store's partitions lend their memos: how a key addresses a partition, and what version it holds. */
export interface PartitionBinding<Key> {
    parts: (key: Key) => readonly string[];
    version: (key: Key) => number;
}
/**
 * A memo dropped by every write to its partition. Reach for it when several reads derive the same value from a
 * partition's rows, or when one read consults it once per item: a memo keyed the way a single read is keyed holds
 * only what that read's own memo already holds.
 */
export declare function byVersion<V>(): <const By extends readonly string[] = readonly []>(spec: {
    max: number;
    /** What the key holds beyond the partition, in order. A memo keyed by the partition alone names nothing. */
    by?: By;
    isEqual?: (prev: V, next: V) => boolean;
}) => MemoDecl<BoundVersionMemo<V, By>>;
/**
 * A memo that outlives the write a version-keyed one is dropped by, because it compares the rows behind the value.
 * Reach for it when the value feeds an identity comparison downstream and a bump elsewhere in the partition should
 * not repaint its readers.
 */
export declare function bySource<V>(): <const By extends readonly string[] = readonly []>(spec: {
    max: number;
    /** What the key holds beyond the partition, in order. A memo keyed by the partition alone names nothing. */
    by?: By;
}) => MemoDecl<BoundSourceMemo<V, By>>;
/** What {@link createMemos} hands back: each declaration, bound to the store whose partitions it holds values for. */
export type BoundMemos<Key, D> = {
    [K in keyof D]: D[K] extends MemoDecl<infer Bound> ? Memo<Key, Bound> : never;
};
/**
 * A store's `memos` as something to hand around: what a hydration or a ranking module declares its own block with,
 * having been handed it by the backend that called `definePartitions`.
 */
export type MemoFactory<Key> = <D extends Record<string, MemoDeclaration>>(decls: D) => BoundMemos<Key, D>;
/**
 * Every memo a store holds, declared in one block: what each keeps, how many of them, and what its key holds beyond
 * the partition. Reached through a store's partitions, which is what supplies the rest of a key and the version it is
 * held against — so the block is a complete account of what a store derives onto the heap, and no caller builds a key.
 */
export declare function createMemos<Key, D extends Record<string, MemoDeclaration>>(store: string, binding: PartitionBinding<Key>, decls: D): BoundMemos<Key, D>;
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
/**
 * What a read compares its value with when it names no `isEqual`, which is what nearly every read wants: one level,
 * the way a store would have written it by hand — a list by its elements, a record by its values, anything else by
 * identity. A hydration that rebuilds a list or a map out of unchanged parts therefore bails its readers out without
 * being asked to, and a read only names a comparison where one level is not enough (see {@link shallowEqualStruct}).
 */
export declare function shallowEqualValue<T>(left: T, right: T): boolean;
/** The same `isEqual` for a read handing back a list: a re-run that produced the same values in the same order is not a change. */
export declare function shallowEqualArray<V>(left: readonly V[], right: readonly V[]): boolean;
export {};
//# sourceMappingURL=caches.d.ts.map