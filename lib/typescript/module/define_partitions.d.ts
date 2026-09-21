/**
 * A store's rows divided into partitions: the addressable slice a fetch replaces, a version tracks, and an ETag
 * belongs to. From `key.where` alone this derives presence, what a fetch replaces, where the ETag lives, and what
 * a write bumps.
 */
import { RawQuery } from './write/fetch_ingest';
import { Read, ReadDef, ReadGroupedDef, ReadManyDef, VarySpec } from './read/surface';
import { RowShape, RowTable } from './table/types';
import { BoundMemos, MemoDeclaration } from './caches';
import { VersionAtom } from './reactivity/version_atom';
import { RowProjection, RowProjectionDef } from './read/projection';
import { PrimeState } from './prime_state';
import { DataResult } from './store_result';
import type { Loose } from './read/facade';
/** No partition: args still being filled in, or a slot a caller left empty, which keeps its index in the result. */
type MaybePartition<Descriptor> = Descriptor | null | undefined;
/**
 * A store reaches its key from a read's args one of two ways: `fields` names the args fields that spell the key,
 * or `of` + `id` map a partition record too big to be a key, which this module interns so a fetch gets it back.
 */
export interface PartitionKeySpec<Row extends RowShape, Key, Args, Descriptor> {
    /** Every field of the key, in the order they spell the version and query keys. Same parts means same partition. */
    fields?: readonly (keyof Key & string)[];
    /**
     * The partition record a read's args address. Pair with `id`; a store declares either these or `fields`. Args
     * arrive as loosely as a screen holds them, so answer nothing for ones still short of a value that names a
     * partition — which reads and primes nothing, the same as a field that has not arrived.
     */
    of?: (args: Loose<Args>) => MaybePartition<Descriptor>;
    /** The key a partition record addresses its rows by. Must be stable and must not collide. */
    id?: (descriptor: Descriptor) => Key;
    /**
     * The partition record a key names — the reverse of {@link id} — for a store whose keys are parseable.
     * Optional, and worth supplying: the record⇄key pairings are bounded, so without this a partition evicted
     * while nothing was reading it cannot be fetched again for the life of the process. With it, eviction costs
     * a parse.
     */
    from?: (key: Key) => MaybePartition<Descriptor>;
    /** The rows one partition holds, as a `WHERE` over the table. */
    where: (key: Key) => Partial<Row>;
}
/** How a partition's rows are fetched. Omit for a store fed by socket pushes. */
export interface PartitionFetchSpec<Row extends RowShape, Key, Descriptor> {
    query: (partition: Descriptor, etag?: string) => RawQuery;
    /** Turns a response body into the partition's rows, which replace it wholesale. */
    parse: (partition: Descriptor, rawJson: string, key: Key) => readonly Row[];
    /** Whether the body is a top-level JSON array, which the native shred requires. Default true. */
    canShredNatively?: (partition: Descriptor) => boolean;
    /** Holds writes for the length of the fetch, so a socket write landing mid-flight survives the replace. */
    holdWrites?: (key: Key) => () => void;
}
/**
 * One store's declaration of its partitions: the table they divide, the version atom they bump, where a key's rows
 * live, and how a body becomes them. `onChanged` is the hook for a store holding a rollup derived from a partition,
 * such as a ranking over it, which new rows invalidate.
 */
export interface PartitionsConfig<Row extends RowShape, Key, Args, Descriptor> {
    name: string;
    table: RowTable<Row>;
    version: VersionAtom;
    key: PartitionKeySpec<Row, Key, Args, Descriptor>;
    fetch?: PartitionFetchSpec<Row, Key, Descriptor>;
    onChanged?: (key: Key, version: number) => void;
    /** How many partitions to remember: record⇄key pairings and fetch timestamps. */
    internMax?: number;
}
/**
 * The partition operations a caller outside the read path reaches for. Every member takes the same args a read
 * does, in the `(args, options?)` shape a backend publishes, so a store publishes the group as-is. The two priming
 * hooks take them loosely, as a screen holds them: they are called unconditionally, from a fixed hook position, and
 * args short of the value that names a partition prime nothing.
 */
interface PartitionLifecycle<Args> {
    /** Primes the partition, holding its hook position on `undefined` args so it can be called unconditionally. */
    usePrime: (args: Loose<Args> | undefined, options?: {
        enabled?: boolean;
    }) => PrimeState;
    usePrimeMany: (args: readonly Args[], options?: {
        enabled?: boolean;
    }) => PrimeState;
    /** The version as a `DataResult`, primed as a read would, for a derivation that then reads imperatively. */
    usePrimeAndVersion: (args: Loose<Args> | undefined, options?: {
        enabled?: boolean;
        prime?: false;
    }) => DataResult<number>;
    /** Whether the partition holds rows. Tracks. */
    has: (args: Args) => boolean;
    /** The partition's version, 0 if never written. Tracks. */
    getVersion: (args: Args) => number;
    /** When rows last landed, epoch ms, 0 if never; only a body that lands moves it. Tracks. */
    getFetchedAt: (args: Args) => number;
    fetch: (args: Args, options?: {
        staleTime?: number;
    }) => Promise<void>;
    refetch: (args: Args) => void;
    /** Marks the partition stale, so the next reader fetches it. */
    invalidate: (args: Args) => void;
    /** Discards every partition's fetch record, so each reads as cold. Called once a store degrades. */
    forget: () => void;
}
/** Args that carry the read's partitions in the field of that name, where `readMany` looks by default. */
interface NamesPartitions<Descriptor> {
    partitions: readonly MaybePartition<Descriptor>[];
}
/** Where a read's partitions come from; `null` and `undefined` both stand for an empty set. */
type PartitionsFrom<Args, Descriptor> = (args: Args) => readonly MaybePartition<Descriptor>[] | null | undefined;
/** `readMany`, naming its partitions as the records a caller holds. Optional when the args already carry them. */
type PartitionReadManyDef<Args, Key, T, Descriptor, V extends VarySpec<Args>> = Omit<ReadManyDef<Args, Key, T, V>, 'partitions'> & (Args extends NamesPartitions<Descriptor> ? {
    partitions?: PartitionsFrom<Args, Descriptor>;
} : {
    partitions: PartitionsFrom<Args, Descriptor>;
});
/** `readGrouped`, likewise: one group of candidate records per thing the caller is asking about. */
interface PartitionReadGroupedDef<Args, Key, T, Descriptor, V extends VarySpec<Args>> extends Omit<ReadGroupedDef<Args, Key, T, V>, 'groups'> {
    groups: (args: Args) => readonly (readonly MaybePartition<Descriptor>[])[];
}
/**
 * Everything one `definePartitions` call hands a backend: the three read constructors it declares its reads with, the
 * row-filter and version primitives its hydration and its own writes are built from, and a `lifecycle` group ready to
 * publish as-is.
 */
export interface Partitions<Row extends RowShape, Key, Args, Descriptor> {
    /**
     * Declares a read, in two calls: `read<Args, Value>()({ … })`. The first names what the read takes and returns, the
     * second takes the read itself — separately, because that is what leaves TypeScript free to infer `varyBy` from the
     * list a read spells, which is how `select` comes to see those fields and no others.
     */
    read: <A extends Args, T>() => <const V extends VarySpec<A> = readonly []>(def: ReadDef<A, Key, T, V>) => Read<A, T>;
    readMany: <A, T>() => <const V extends VarySpec<A> = readonly []>(def: PartitionReadManyDef<A, Key, T, Descriptor, V>) => Read<A, T>;
    /** One group of candidates per thing the caller asks about; `select` gets them back in those groups. */
    readGrouped: <A, T>() => <const V extends VarySpec<A> = readonly []>(def: PartitionReadGroupedDef<A, Key, T, Descriptor, V>) => Read<A, T>;
    /**
     * Every value this store memoizes, declared in one block and bound to these partitions: each memo takes a key and
     * derives the rest of its own key and the version it holds against, so a hydration names the partition and the
     * thing it wants and never builds either. See {@link createMemos}.
     */
    memos: <D extends Record<string, MemoDeclaration>>(decls: D) => BoundMemos<Key, D>;
    /**
     * Declares a view-model shape built one row at a time, in two calls like the reads: `project<Vm>()({ … })`. Every
     * read handing back that shape goes through the one projection, so a row is built once however many ask, and a
     * version bump only rebuilds the rows whose content actually moved. See {@link createRowProjection}.
     */
    project: <Vm>() => (def: RowProjectionDef<Row, Vm>) => RowProjection<Key, Row, Vm>;
    where: (key: Key) => Partial<Row>;
    /** The key a partition record addresses, interning the pairing so a fetch can get the record back. */
    keyOf: (partition: Descriptor) => Key;
    /** The interned keys, least- to most-recently named. */
    internedKeys: () => IterableIterator<Key>;
    /** Whether the partition holds rows. Tracks. */
    has: (key: Key) => boolean;
    /** The partition's version, 0 if never written. Tracks. */
    versionOf: (key: Key) => number;
    /** Raises the version and runs `onChanged`, for a store that put rows in itself. */
    bump: (key: Key) => number;
    /** Drops the partition's ETag, so its next fetch comes back with a whole body. */
    clearEtag: (key: Key) => void;
    lifecycle: PartitionLifecycle<Args>;
}
/**
 * The middle layer of a store, and the call its backend is built around: answer where one partition's rows live
 * (`key.where`) and how a response body becomes them (`fetch`), and get back the reads, the ETag handling, the priming
 * and the version bumps derived from those answers. Called once per store, from `buildXBackend` after `table.init()`.
 */
export declare function definePartitions<Row extends RowShape, Key, Args = Key, Descriptor = Args>(config: PartitionsConfig<Row, Key, Args, Descriptor>): Partitions<Row, Key, Args, Descriptor>;
export {};
//# sourceMappingURL=define_partitions.d.ts.map