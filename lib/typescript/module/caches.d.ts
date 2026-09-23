/**
 * Bounded caches for values derived from off-heap rows. A value is held against what it depends on — a partition's
 * version for one derived from the whole partition, a unit's for one derived from that unit's rows — so a write that
 * changed nothing it read leaves it in place, and an `isEqual` keeps the reference when a rebuild changed nothing.
 * A store reaches these through {@link createMemos}, which is where it accounts for all of them at once.
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
/** Builds one. Stores declare theirs through {@link createMemos}; the read surface holds one for presence. */
export declare function createVersionedCache<V>(maxEntries: number, isEqual?: (prev: V, next: V) => boolean, diagnostics?: MemoDiagnostics): VersionedCache<V>;
/**
 * A value held against whatever its computation read, which is how the read surface caches a read's result: the
 * computation runs in a tracking scope, and the entry stays valid while every version it reported is unchanged. A read
 * of three players therefore survives a write that changed a fourth. Every lookup reports those same dependencies to
 * the scope above it, hit or miss, so a caller subscribing to what it read never misses one because it was cached.
 */
export interface TrackedCache<V> {
    read(key: string, compute: () => V): V;
}
/** Builds one. `isEqual` hands back the prior reference when a recompute produced an equal value. */
export declare function createTrackedCache<V>(maxEntries: number, isEqual?: (prev: V, next: V) => boolean): TrackedCache<V>;
/**
 * What a memo's key holds beyond the partition: a scalar, or a structured value — a config object, an options subset —
 * which the kernel interns into a short id, so keying by one costs a key the length of an id rather than of its JSON.
 */
export type MemoPart = string | number | boolean | null | undefined | readonly unknown[] | Record<string, unknown>;
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
/**
 * A memo bound to one partition whose entries each belong to one unit, and stay valid until that unit changes. Every
 * lookup reports the unit it names, so a read built from these depends on those units and nothing else.
 */
export interface BoundUnitMemo<V, By extends readonly string[]> {
    /** The value held for `unit` and these parts, built on a miss or once the unit has changed. */
    read(unit: string, ...args: [...PartsOf<By>, build: () => V]): V;
    /**
     * The values for `units`, answering what it holds and building every miss in one call, so a read of a roster costs
     * one query for the players that changed rather than one each. `build` is handed the units to build and answers for
     * each; a unit it leaves out is held as absent.
     */
    readMany(units: readonly string[], ...args: [...PartsOf<By>, build: (missing: readonly string[]) => ReadonlyMap<string, V>]): Map<string, V>;
}
/** A declared memo, reached by naming the partition it holds values for. */
export interface Memo<Key, Bound> {
    for(key: Key): Bound;
}
/** A memo as declared, before a store's partitions bind it. {@link byVersion} and {@link byUnit} are the two. */
interface MemoDecl<Bound> {
    by: readonly string[];
    bind(store: PartitionBinding<unknown>, diagnostics: MemoDiagnostics): Memo<unknown, Bound>;
}
/** What a `memos` block's entries are, whatever they hold: what {@link byVersion} and {@link byUnit} return. */
export type MemoDeclaration = MemoDecl<unknown>;
/** What a store's partitions lend their memos: how a key addresses a partition, and what version it holds. */
export interface PartitionBinding<Key> {
    parts: (key: Key) => readonly string[];
    /** The partition's version. Tracks the partition. */
    version: (key: Key) => number;
    /** The version one unit last changed at. Tracks that unit alone. */
    unitVersion: (key: Key, unit: string) => number;
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
 * A memo whose entries each belong to one unit — a player, a team — and survive every write that did not change that
 * unit. Reach for it for a value built from one unit's rows: a write that changed other units leaves the entry and its
 * reference alone, and a read built from it depends on the units it names and nothing else.
 *
 * A build's table reads are covered by the unit it reports, so they do not widen the read around it to the partition.
 */
export declare function byUnit<V>(): <const By extends readonly string[] = readonly []>(spec: {
    max: number;
    /** What the key holds beyond the partition and the unit, in order. */
    by?: By;
    isEqual?: (prev: V, next: V) => boolean;
}) => MemoDecl<BoundUnitMemo<V, By>>;
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