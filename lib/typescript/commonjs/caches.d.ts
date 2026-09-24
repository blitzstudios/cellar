/**
 * Size-limited caches for values computed from table rows. Each value is kept until what it was computed from changes:
 * its partition, or the one unit it was built from. An `isEqual` keeps the previous object when a rebuild produces an
 * equal value. Stores declare theirs with {@link createMemos}.
 */
/** How a memo is named in its dev warnings. */
export interface MemoDiagnostics {
    /** The memo's name, as `store.memo`. */
    name: string;
    /** What its keys are built from, such as `partition + unit`. */
    keyedBy: string;
}
/**
 * A map with string keys and a fixed capacity, which drops its least recently used entry when full. Every cache here is
 * built on one, and a store can use one for its own bounded lookups.
 */
export interface BoundedLru<V> {
    /**
     * The value for `key`, marking it recently used. Returns `undefined` for a missing key and a stored `undefined`
     * alike.
     */
    get(key: string): V | undefined;
    /** Stores a value, dropping the least recently used entry if full. */
    set(key: string, value: V): void;
    /** Every key, from least to most recently used. */
    keys(): IterableIterator<string>;
}
/**
 * Creates a {@link BoundedLru} holding at most `max` entries. `onEvict` is called with each key dropped to make room.
 */
export declare function createBoundedLru<V>(max: number, onEvict?: (key: string) => void): BoundedLru<V>;
/**
 * A cache of values stored with the version they were computed at. A lookup at a different version misses, so a value
 * is recomputed once after each write. An `isEqual` keeps the previous object when the recompute is equal to it.
 */
export interface VersionedCache<V> {
    /** The value for `key` at `version`, computing and storing it on a miss. */
    read(key: string, version: number, compute: () => V): V;
    /** The value for `key` at `version`, as `{ value }` so a stored `undefined` is distinguishable from a miss. */
    peek(key: string, version: number): {
        value: V;
    } | undefined;
    /** Stores `value` and returns the object to use, which is the previous one if `isEqual` says they match. */
    set(key: string, version: number, value: V): V;
}
/** Creates a {@link VersionedCache}. Stores declare theirs through {@link createMemos}. */
export declare function createVersionedCache<V>(maxEntries: number, isEqual?: (prev: V, next: V) => boolean, diagnostics?: MemoDiagnostics): VersionedCache<V>;
/**
 * A cache of values kept until anything their computation read changes; this is how reads cache their results. A read
 * of three players keeps its value through a write that changed a fourth. Every lookup, hit or miss, passes the
 * value's dependencies up to the caller's tracking scope, so a cached value is subscribed to like a computed one.
 */
export interface TrackedCache<V> {
    /** The value for `key`, recomputing it if anything it read has changed. */
    read(key: string, compute: () => V): V;
}
/** Creates a {@link TrackedCache}. `isEqual` keeps the previous object when a recompute produces an equal value. */
export declare function createTrackedCache<V>(maxEntries: number, isEqual?: (prev: V, next: V) => boolean): TrackedCache<V>;
/**
 * One part of a memo's key beyond the partition: a scalar, or an object or array such as a config. Equal objects map to
 * the same short id, so an object costs no more in the key than a scalar.
 */
export type MemoPart = string | number | boolean | null | undefined | readonly unknown[] | Record<string, unknown>;
/** One `MemoPart` per name the memo declared in `by`, in that order. */
type PartsOf<By extends readonly string[]> = {
    -readonly [Index in keyof By]: MemoPart;
};
/**
 * A {@link byVersion} memo for one partition, as returned by `memo.for(key)`. Its entries are keyed by the parts listed
 * in `by`, and are dropped by any write to the partition.
 */
export interface BoundVersionMemo<V, By extends readonly string[]> {
    /** The value for these key parts, running `build` and storing its result on a miss. */
    read(...args: [...PartsOf<By>, build: () => V]): V;
    /** The value for these key parts, as `{ value }` so a stored `undefined` is distinguishable from a miss. */
    peek(...parts: PartsOf<By>): {
        value: V;
    } | undefined;
    /** Stores a value and returns the object to use, which is the previous one if `isEqual` says they match. */
    set(...args: [...PartsOf<By>, value: V]): V;
}
/**
 * A {@link byUnit} memo for one partition, as returned by `memo.for(key)`. Each entry belongs to one unit and is
 * kept until that unit's rows change. A read that uses it re-renders only when the units it asked for change.
 */
export interface BoundUnitMemo<V, By extends readonly string[]> {
    /** The value for `unit` and these key parts, running `build` on a miss or after the unit changed. */
    read(unit: string, ...args: [...PartsOf<By>, build: () => V]): V;
    /**
     * The values for `units`, building every missing one in a single `build` call, so a roster read costs one query
     * for the players that changed rather than one per player. `build` gets the units to build and returns a map of
     * their values; a unit it leaves out is stored as `undefined`.
     */
    readMany(units: readonly string[], ...args: [...PartsOf<By>, build: (missing: readonly string[]) => ReadonlyMap<string, V>]): Map<string, V>;
}
/** A memo declared in a store's `memos` block. */
export interface Memo<Key, Bound> {
    /** The memo for one partition. */
    for(key: Key): Bound;
}
/**
 * A memo definition, before {@link createMemos} attaches it to a store. {@link byVersion} and {@link byUnit} create
 * them.
 */
interface MemoDecl<Bound> {
    /** The names of the memo's key parts beyond the partition. */
    by: readonly string[];
    /** Attaches the memo to a store's partitions. */
    bind(store: PartitionBinding<unknown>, diagnostics: MemoDiagnostics): Memo<unknown, Bound>;
}
/** A memo definition, as created by {@link byVersion} or {@link byUnit}. */
export type MemoDeclaration = MemoDecl<unknown>;
/** What a store's partitions give its memos: each partition's key parts and version. */
export interface PartitionBinding<Key> {
    /** The partition's key parts. */
    parts: (key: Key) => readonly string[];
    /** The partition's version. Tracked: a derivation that calls it re-runs on any write to the partition. */
    version: (key: Key) => number;
    /** The version at which one unit last changed. Tracked: a derivation that calls it re-runs when that unit changes. */
    unitVersion: (key: Key, unit: string) => number;
}
/**
 * Declares a memo of values computed from a whole partition, dropped by any write to it. Use it for a value several
 * reads share, or one a read looks up per item. A memo keyed exactly like one read adds nothing, since the read
 * already caches its result.
 */
export declare function byVersion<V>(): <const By extends readonly string[] = readonly []>(spec: {
    /** How many values to keep. */
    max: number;
    /**
     * Names for the key parts beyond the partition, in the order they are passed; none for a memo keyed by partition
     * alone.
     */
    by?: By;
    /** Keeps the previous object when a rebuilt value is equal to it. */
    isEqual?: (prev: V, next: V) => boolean;
}) => MemoDecl<BoundVersionMemo<V, By>>;
/**
 * Declares a memo of values built from one unit's rows, such as a player's, each kept until that unit changes. A write
 * to other units leaves the entry and its object alone, and a read using it re-renders only when its own units change.
 * Table reads inside `build` count as reads of that unit, not of the whole partition.
 */
export declare function byUnit<V>(): <const By extends readonly string[] = readonly []>(spec: {
    /** How many values to keep. */
    max: number;
    /** Names for the key parts beyond the partition and unit, in the order they are passed. */
    by?: By;
    /** Keeps the previous object when a rebuilt value is equal to it. */
    isEqual?: (prev: V, next: V) => boolean;
}) => MemoDecl<BoundUnitMemo<V, By>>;
/** The memos {@link createMemos} returns, each attached to the store's partitions. */
export type BoundMemos<Key, D> = {
    [K in keyof D]: D[K] extends MemoDecl<infer Bound> ? Memo<Key, Bound> : never;
};
/**
 * A store's `memos` function, which declares a block of memos attached to its partitions. A store's `build` passes it
 * to modules, such as a hydration or a ranker, that declare their own memos.
 */
export type MemoFactory<Key> = <D extends Record<string, MemoDeclaration>>(decls: D) => BoundMemos<Key, D>;
/**
 * Attaches a block of memo definitions to a store's partitions. Each memo reads its partition's key and version from
 * the store, so callers pass only the parts named in `by`. Declaring them in one block lists everything a store keeps
 * in memory beyond its rows.
 */
export declare function createMemos<Key, D extends Record<string, MemoDeclaration>>(store: string, binding: PartitionBinding<Key>, decls: D): BoundMemos<Key, D>;
/** Whether two records have the same keys and identical (`Object.is`) values, such as two maps of view models by id. */
export declare function shallowEqualRecord<V>(left: Record<string, V>, right: Record<string, V>): boolean;
/**
 * Builds an `isEqual` for an object: fields named in `deep` use their given comparison, and every other field
 * `Object.is`. A field left out that holds a newly built object always compares unequal, which costs a re-render
 * rather than a stale value.
 */
export declare function shallowEqualStruct<T extends object>(deep: {
    [K in keyof T]?: (left: T[K], right: T[K]) => boolean;
}): (left: T, right: T) => boolean;
/**
 * A one-level comparison: arrays by their elements, plain objects by their values, anything else by identity. It is
 * the default `isEqual` for reads, so a rebuilt list or map of unchanged items doesn't re-render. For a value that
 * needs a deeper comparison, see {@link shallowEqualStruct}.
 */
export declare function shallowEqualValue<T>(left: T, right: T): boolean;
/** Whether two arrays hold identical (`Object.is`) elements in the same order. */
export declare function shallowEqualArray<V>(left: readonly V[], right: readonly V[]): boolean;
export {};
//# sourceMappingURL=caches.d.ts.map