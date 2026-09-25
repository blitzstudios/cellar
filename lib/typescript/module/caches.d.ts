/**
 * Caches for values a store computes from its table rows, each holding a fixed number of entries.
 *
 * A store's rows live in SQLite, and every query returns new objects, so anything computed from them (a view model, a
 * ranking, a lookup map) would be rebuilt on every read without a cache. A cache keeps each computed value together
 * with the version of the rows it was computed from, and returns it until those rows change: a {@linkcode byVersion}
 * cache until any write to its partition (the set of rows one fetch returns and replaces), a {@linkcode byUnit} cache
 * until a write to its unit (all the rows sharing one value of the table's unit column, such as one player's rows).
 * When a value is rebuilt and `isEqual` finds it equal to the previous one, the previous object is kept, so readers
 * don't re-render. Stores declare their caches in one block, {@linkcode Partitions.cache | cache}.
 *
 * The per-partition machinery underneath is a memo: {@linkcode byVersion}'s entries, and {@linkcode unitMemo}, which
 * holds a {@linkcode byUnit} cache's values.
 */
import type { CommonDef, ReadDef } from './read/surface';
import type { Partitions } from './define_partitions';
import type { byUnit } from './read/derived_values';
/** How a memo is described in its dev reports (a memo too small for what it's asked to hold, or one never used). */
export interface MemoDiagnostics {
    /** The memo's name, as `store.memo`, such as `player.byTeam`. */
    name: string;
    /** What the memo's entries are keyed by, for the report's text, such as `partition + unit + scope`. */
    keyedBy: string;
}
/**
 * A map with string keys that holds at most a fixed number of entries: when a new key would exceed the limit, the
 * least recently used entry (the one read or written longest ago) is removed. Every cache in the kernel is built on
 * one, and a store can use one for a lookup table of its own that shouldn't grow without limit.
 */
export interface BoundedLru<V> {
    /**
     * The value stored under `key`, which also marks it as recently used. Returns `undefined` both for a key that isn't
     * stored and for a stored `undefined`; store values wrapped in an object if the two must be told apart.
     */
    get(key: string): V | undefined;
    /**
     * Stores `value` under `key` and marks it as recently used. If that makes the map exceed its limit, removes the least
     * recently used entry.
     */
    set(key: string, value: V): void;
    /** Every stored key, from least to most recently used. */
    keys(): IterableIterator<string>;
}
/**
 * Creates a {@linkcode BoundedLru}: a map with string keys that holds at most `max` entries, removing the least
 * recently used one to make room. `onEvict` is called with the key of each entry removed that way.
 */
export declare function createBoundedLru<V>(max: number, onEvict?: (key: string) => void): BoundedLru<V>;
/**
 * A cache whose entries each remember the version number they were computed at (typically a partition's version,
 * which goes up on every write that changes it). A lookup passes the current version, and an entry from any other
 * version counts as missing, so each value is recomputed once after each write and served from the cache in between.
 * When a recomputed value is equal to the previous one by `isEqual`, the previous object is kept.
 */
export interface VersionedCache<V> {
    /**
     * The value stored for `key` at `version`. On a miss (no entry, or one from another version), runs `compute`,
     * stores its result at `version`, and returns it (or the previous object, if `isEqual` finds them equal).
     */
    read(key: string, version: number, compute: () => V): V;
    /**
     * The value stored for `key` at `version`, without computing anything: `{ value }` on a hit, `undefined` on a miss.
     * Wrapped so that a stored `undefined` can be told apart from a miss.
     */
    peek(key: string, version: number): {
        value: V;
    } | undefined;
    /**
     * Stores `value` for `key` at `version`, and returns the object to use from now on: the previous value's object if
     * `isEqual` finds the two equal, otherwise `value`.
     */
    set(key: string, version: number, value: V): V;
}
/**
 * Creates a {@linkcode VersionedCache} holding at most `maxEntries` values, removing the least recently used to make
 * room. Stores declare theirs through {@linkcode createMemos} rather than calling this.
 */
export declare function createVersionedCache<V>(maxEntries: number, isEqual?: (prev: V, next: V) => boolean, diagnostics?: MemoDiagnostics): VersionedCache<V>;
/**
 * A cache whose entries each remember exactly what their computation read (the partition, unit and presence versions
 * it looked at) and stay valid until one of those changes. It is how reads cache their values: a read of three players
 * keeps its value through a write that changed a fourth. Every lookup, hit or miss, reports the entry's dependencies to
 * the caller's tracking scope, so a component reading a cached value is subscribed to the same things as one that
 * computed it.
 */
export interface TrackedCache<V> {
    /**
     * The value stored for `key`, if nothing it read has changed since it was computed. Otherwise runs `compute`,
     * records what it read, stores the result, and returns it (or the previous object, if `isEqual` finds them equal).
     */
    read(key: string, compute: () => V): V;
}
/**
 * Creates a {@linkcode TrackedCache} holding at most `maxEntries` values, removing the least recently used to make
 * room. `isEqual` compares a recomputed value with the previous one, and keeps the previous object when they're equal.
 */
export declare function createTrackedCache<V>(maxEntries: number, isEqual?: (prev: V, next: V) => boolean): TrackedCache<V>;
/**
 * One part of a cache entry's key, beyond the partition (and unit): a string, number, boolean, null or undefined, or an
 * object or array, such as a scoring config. Objects and arrays are compared by content, and each distinct content is
 * replaced in the key by a short id, so a large object doesn't make every key long.
 */
export type CacheKeyPart = string | number | boolean | null | undefined | readonly unknown[] | Record<string, unknown>;
/** One {@linkcode CacheKeyPart} per name the cache declared in {@linkcode MemoDecl.by | by}, in that order. */
type PartsOf<By extends readonly string[]> = {
    -readonly [Index in keyof By]: CacheKeyPart;
};
/**
 * A {@linkcode byVersion} cache's entries for one partition, as `.for(key)` returns them. A partition is the set of rows
 * one fetch returns and replaces. Entries are keyed by the parts named in the cache's {@linkcode MemoDecl.by | by},
 * passed in that order, and every entry counts as missing after any write that changes the partition.
 *
 * `.for(key)` reads the partition's version when it is called, so call it where the value is needed rather than
 * keeping its result. It is tracked: a read whose {@linkcode ReadDef.select | select} calls it depends on the whole
 * partition, and re-runs after any write that changes it.
 */
export interface BoundVersionMemo<V, By extends readonly string[]> {
    /**
     * The value stored for these key parts. On a miss (never computed, or computed before the partition's last write),
     * runs `build`, stores its result, and returns it (or the previous object, if `isEqual` finds them equal).
     */
    read(...args: [...PartsOf<By>, build: () => V]): V;
    /**
     * The value stored for these key parts, without building anything: `{ value }` on a hit, `undefined` on a miss.
     * Wrapped so that a stored `undefined` can be told apart from a miss.
     */
    peek(...parts: PartsOf<By>): {
        value: V;
    } | undefined;
    /**
     * Stores a value for these key parts (the value comes last), and returns the object to use from now on: the previous
     * value's object if `isEqual` finds the two equal, otherwise the new one.
     */
    set(...args: [...PartsOf<By>, value: V]): V;
}
/**
 * A {@linkcode unitMemo} for one partition, as `.for(key)` returns it: where a {@linkcode byUnit} cache keeps its
 * values. A unit is all the rows sharing one value of the table's unit column, such as one player's rows. Each entry
 * belongs to one unit and is kept until a write changes that unit's rows.
 *
 * Every lookup is tracked per unit: a read whose {@linkcode ReadDef.select | select} looks up units here depends on
 * just those units, and doesn't re-run for writes to other units. Table reads inside `build` count as reads of that
 * unit, not of the whole partition.
 */
export interface BoundUnitMemo<V, By extends readonly string[]> {
    /**
     * The value stored for `unit` (a value of the unit column, such as a `player_id`) and these key parts. On a miss
     * (never built, or built before the unit's last change), runs `build`, stores its result, and returns it.
     */
    read(unit: string, ...args: [...PartsOf<By>, build: () => V]): V;
    /**
     * The values stored for each of `units` (values of the unit column, such as player ids) and these key parts, as a map
     * by unit. Every unit that misses is built in one `build` call, so a roster read costs one query for the players that
     * changed rather than one query per player. `build` gets the missing units and returns a map of their values; a unit
     * it leaves out is stored as `undefined`.
     */
    readMany(units: readonly string[], ...args: [...PartsOf<By>, build: (missing: readonly string[]) => ReadonlyMap<string, V>]): Map<string, V>;
}
/**
 * A {@linkcode byVersion} cache as a store's {@linkcode Partitions.cache | cache} block returns it: one cache for the
 * whole store, with entries kept per partition. A partition is the set of rows one fetch returns and replaces.
 */
export interface Memo<Key, Bound> {
    /**
     * The cache's entries for one partition, to read and write. Reads the partition's current version, so call it where
     * the value is needed rather than keeping its result.
     */
    for(key: Key): Bound;
}
/**
 * A memo definition, before {@linkcode createMemos} attaches it to a store: a {@linkcode byVersion} cache, or the
 * {@linkcode unitMemo} under a {@linkcode byUnit} cache.
 */
export interface MemoDecl<Bound> {
    /** The names of the memo's key parts beyond the partition (and unit), in the order a lookup passes them. */
    by: readonly string[];
    /** Attaches the memo to a store's partitions, which supply each partition's key and versions. */
    bind(store: PartitionBinding<unknown>, diagnostics: MemoDiagnostics): Memo<unknown, Bound>;
}
/** A memo definition of any kind, before {@linkcode createMemos} attaches it to a store. */
export type MemoDeclaration = MemoDecl<unknown>;
/**
 * What a store's partitions give its caches: how to turn a partition key into its key parts, and how to read the
 * partition's version and each unit's. A partition is the set of rows one fetch returns and replaces; a unit is all the
 * rows sharing one value of the table's unit column.
 */
export interface PartitionBinding<Key> {
    /** A partition key's parts: its values as a list of strings, which prefix every memo entry's key. */
    parts: (key: Key) => readonly string[];
    /**
     * The partition's version number, which goes up on every write that changes it. Tracked: inside a tracking scope, the
     * scope re-runs after any such write.
     */
    version: (key: Key) => number;
    /**
     * The version at which one unit last changed. Tracked: inside a tracking scope, the scope re-runs only after a write
     * that changes that unit's rows.
     */
    unitVersion: (key: Key, unit: string) => number;
}
/**
 * Declares a cache of values computed from a whole partition (the set of rows one fetch returns and replaces), such as
 * a map of a league's players by team, for a store's {@linkcode Partitions.cache | cache} block. Every entry counts as
 * missing after any write that changes its partition, and the value is computed again at the next lookup, by the
 * `build` that lookup passes. A read that uses it depends on the whole partition.
 *
 * Use it for a value several reads share, or one a read looks up once per item in a list. A cache keyed exactly like a
 * single read adds nothing, since the read already caches its own value. Called in two steps, so the value type can be
 * given while {@linkcode MemoDecl.by | by} is inferred: `byVersion<Map<string, Player[]>>()({ max: 8 })`.
 */
export declare function byVersion<V>(): <const By extends readonly string[] = readonly []>(spec: {
    /** How many values to keep, across all partitions; beyond that, the least recently used are discarded. */
    max: number;
    /**
     * Names for the key's parts beyond the partition, in the order a lookup passes them, such as `['scoring']`. Leave
     * it out for a cache with one value per partition.
     */
    by?: By;
    /**
     * Compares a rebuilt value with the previous one; when they're equal, the previous object is kept, so readers
     * comparing by reference don't re-render.
     */
    isEqual?: (prev: V, next: V) => boolean;
}) => MemoDecl<BoundVersionMemo<V, By>>;
/**
 * Declares a memo of values built from one unit's rows: where a {@linkcode byUnit} cache keeps its values, which a
 * store declares instead. A unit is all the rows sharing one value of the table's unit column (such as `player_id`).
 * Each entry is kept until a write changes that unit's rows.
 *
 * A read that looks units up here depends on just those units, so it re-runs only when one of them changes. Table reads
 * inside `build` count as reads of that unit, not of the whole partition. Called in two steps, so the value type can be
 * given while {@linkcode MemoDecl.by | by} is inferred: `unitMemo<SeasonTotals>()({ max: 512 })`.
 */
export declare function unitMemo<V>(): <const By extends readonly string[] = readonly []>(spec: {
    /** How many values to keep, across all partitions and units; beyond that, the least recently used are discarded. */
    max: number;
    /**
     * Names for the key's parts beyond the partition and unit, in the order a lookup passes them, such as
     * `['scoring']`. Leave it out for a memo with one value per unit.
     */
    by?: By;
    /**
     * Compares a rebuilt value with the previous one; when they're equal, the previous object is kept, so readers
     * comparing by reference don't re-render.
     */
    isEqual?: (prev: V, next: V) => boolean;
}) => MemoDecl<BoundUnitMemo<V, By>>;
/**
 * The memos {@linkcode createMemos} returns: one per entry of the block it was given, each attached to the store's
 * partitions.
 */
export type BoundMemos<Key, D> = {
    [K in keyof D]: D[K] extends MemoDecl<infer Bound> ? Memo<Key, Bound> : never;
};
/**
 * Attaches memo definitions (a {@linkcode byVersion} cache, or a {@linkcode unitMemo}) to a store's partitions,
 * returning one usable memo per entry. Each memo gets its partition's key parts and versions from `binding`, so a
 * lookup passes only the parts named in {@linkcode MemoDecl.by | by}.
 */
export declare function createMemos<Key, D extends Record<string, MemoDeclaration>>(store: string, binding: PartitionBinding<Key>, decls: D): BoundMemos<Key, D>;
/**
 * Whether two objects have the same keys with identical values (`Object.is`), one level deep, such as two maps of view
 * models by id. For use as a read's {@linkcode CommonDef.isEqual | isEqual}.
 */
export declare function shallowEqualRecord<V>(left: Record<string, V>, right: Record<string, V>): boolean;
/**
 * Builds an {@linkcode CommonDef.isEqual | isEqual} for an object value, for a read's
 * {@linkcode CommonDef.isEqual | isEqual}: the two objects are equal when they have the same keys, each field named in
 * `deep` is equal by the comparison given for it, and every other field is identical (`Object.is`). Name the fields
 * that hold newly built lists or objects; one left out compares unequal whenever it's rebuilt, which costs a re-render
 * rather than showing a stale value.
 */
export declare function shallowEqualStruct<T extends object>(deep: {
    [K in keyof T]?: (left: T[K], right: T[K]) => boolean;
}): (left: T, right: T) => boolean;
/**
 * Whether two values are equal one level deep: arrays when their elements are identical in order, plain objects when
 * they have the same keys with identical values, and anything else when it is the same value (`Object.is`). It is the
 * default {@linkcode CommonDef.isEqual | isEqual} for reads, so a read that rebuilds a list or map of unchanged items
 * doesn't re-render. For a value that needs a deeper comparison, see {@linkcode shallowEqualStruct}.
 */
export declare function shallowEqualValue<T>(left: T, right: T): boolean;
/** Whether two arrays have the same length and identical elements (`Object.is`) in the same order. */
export declare function shallowEqualArray<V>(left: readonly V[], right: readonly V[]): boolean;
export type { CommonDef, Partitions, ReadDef, byUnit };
//# sourceMappingURL=caches.d.ts.map