/**
 * Turns one read declaration into a store's `useValue` (reactive) and `getValue` (imperative) pair.
 * `read` is scoped to one partition; `readMany` spans a variable set of them.
 */
import { VaryValue } from '../args_key';
import { PartitionField, VaryField } from './partition_fields';
import { VersionAtom } from '../reactivity/version_atom';
import { type PrimeState } from '../prime_state';
import { DataResult, DataStatus } from '../store_result';
/** The fetch half of a store as a read sees it, which `createFetchIngest`'s return value satisfies. */
export interface FetchOwner<Key> {
    usePrime: (key: Key | undefined, enabled: boolean, opts?: {
        slice?: boolean;
    }) => PrimeState;
    usePrimeMany: (keys: readonly Key[], enabled: boolean, opts?: {
        slice?: boolean;
    }) => PrimeState;
    /** Starts the partition's fetch; the surface calls it only for a partition `has` reports cold. */
    ensure: (key: Key) => void;
    refetch: (key: Key) => void;
}
/**
 * What a read surface needs from its store: the version atom, a key's parts, a presence probe, and the fetch that
 * backs priming. `definePartitions` derives all of it from where a partition's rows live.
 */
export interface ReadSurfaceKernel<Key> {
    version: VersionAtom;
    /** Names this store in the fan-out warning. */
    name?: string;
    /** A key's parts, in the order that keys the version atom. */
    toParts: (key: Key) => readonly string[];
    /** Whether a partition holds rows. Gates `select`. */
    has: (key: Key) => boolean;
    /**
     * Whether a partition's rows came from a fetch. Rows alone do not say: a socket push writes into a partition
     * nothing ever fetched, and in a store fed by both, one pushed row would otherwise stand in for the body.
     */
    hasFetched?: (key: Key) => boolean;
    /**
     * What a read falls back on when it declares no `partition`: the store's key fields, or a function for a store
     * whose key arrives whole in one arg. Supplying the function promises every `read`'s args carry the key.
     */
    defaultPartition?: readonly string[] | ((args: never) => Key);
    /** The store's fetch ingest; a push-fed store omits it, and its empty partitions then read as `success`. */
    ingest?: FetchOwner<Key>;
}
/** A read's `varyBy`: either a list of args fields, or a function computing the values from the args. */
export type VarySpec<Args> = readonly VaryField<Args>[] | ((args: Args) => readonly VaryValue[]);
/**
 * The args a read's `select` receives: only the fields listed in `varyBy`, each non-null, since the read does not run
 * until every one has a value. Reading an arg the read never listed would serve one caller's value to another, so it
 * does not typecheck. A `varyBy` written as a function lists no fields, so its `select` receives the whole args.
 */
export type SelectArgs<Args, V> = V extends readonly (keyof Args)[] ? {
    [K in V[number]]: NonNullable<Args[K & keyof Args]>;
} : Args;
/** The fields every kind of read definition shares. */
interface CommonDef<Args, T, V extends VarySpec<Args>> {
    /** Turns the read off for some args, returning `empty` and fetching nothing, such as a sentinel id. */
    enabled?: (args: Args) => boolean;
    /**
     * The args fields `select` uses beyond the partition, such as a player id or a team. Together with the partition
     * they are the read's cache key, so list every field `select` uses; it can see no others, and the read is off while
     * any of them is missing.
     */
    varyBy?: V;
    /**
     * The args fields a caller must have before the read runs, for a read whose partitions come from a function rather
     * than a field list. It becomes {@link Read.requires}, which is what lets {@link pairRead} publish the read.
     */
    requires?: readonly string[];
    /**
     * What the read returns while loading, disabled, or missing args. Must be the same object every time, such as a
     * frozen constant.
     */
    empty: T;
    /**
     * Compares two results of the read; an equal new result keeps the previous object, so readers don't re-render.
     * Defaults to {@link shallowEqualValue}, which suits a list or record of stable values; pass one built with
     * {@link shallowEqualStruct} where equality depends on a level deeper.
     */
    isEqual?: (left: T, right: T) => boolean;
    /** How many results to cache, keyed by partition and args, shared by every caller; 256 by default. */
    getCacheMax?: number;
    /**
     * Whether reading a partition that has not been fetched fetches it; true by default. Set false for a read that only
     * guesses at partitions, or looks something up in whatever is already loaded.
     *
     * A fetch loads the whole partition, not just what the read selects, so a read of one row in a large partition
     * pays for all of it. The fix for that is at the call site (use a payload that already has the rows) or in the
     * store's partition key, not here. A fetch large enough to matter reports itself once per session; see
     * `reportOversizedPrime`.
     */
    prime?: boolean;
}
/**
 * A read of one partition: the args name one partition, and `select` computes the result from it. Nearly every read is
 * this kind. Use `ReadManyDef` for a read across several partitions, and `ReadGroupedDef` for several lookups at once,
 * each with its own candidate partitions.
 */
export interface ReadDef<Args, Key, T, V extends VarySpec<Args> = readonly []> extends CommonDef<Args, T, V> {
    /**
     * How the args name the partition: a list of args fields, or a function returning the key. Defaults to the store's
     * key fields; a store whose key isn't a set of args fields must pass the function.
     */
    partition?: readonly PartitionField<Args>[] | ((args: Args) => Key);
    /**
     * Computes the result from the partition's rows. Runs only once the partition holds rows; until then the read returns
     * `empty`.
     */
    select: (args: SelectArgs<Args, V>, key: Key) => T;
}
/**
 * A read across several partitions, fetched and subscribed together and returned as one value, such as one player's
 * rows across several weeks. `select` gets the keys as one flat list; use `ReadGroupedDef` for several lookups at once.
 */
export interface ReadManyDef<Args, Key, T, V extends VarySpec<Args> = readonly []> extends CommonDef<Args, T, V> {
    /** The partitions the args name. A key that names nothing keeps its place in the list as a gap. */
    partitions: (args: Args) => readonly Key[];
    /** Computes the result from the partitions, handed their keys in the order `partitions` returned them. */
    select: (args: SelectArgs<Args, V>, keys: readonly Key[]) => T;
}
/**
 * A read that answers several lookups at once, each with its own candidate partitions, such as a row for each of
 * several stat keys that could each live in more than one partition. `select` gets the candidates back grouped per
 * lookup, in order.
 */
export interface ReadGroupedDef<Args, Key, T, V extends VarySpec<Args> = readonly []> extends CommonDef<Args, T, V> {
    /** One group of candidate partitions per lookup. Every partition in every group is fetched and subscribed to. */
    groups: (args: Args) => readonly (readonly Key[])[];
    /** Computes the result, handed the groups in the order `groups` returned them. */
    select: (args: SelectArgs<Args, V>, groups: readonly (readonly Key[])[]) => T;
}
/** Options one caller passes to a read's hook, on top of what the read's definition fixes. */
export interface ReadCallOptions {
    /** Set false to turn this caller's read and fetch off while its hook stays mounted; true by default. */
    enabled?: boolean;
    /**
     * Set false to read without fetching, for a caller whose parent already fetches the partition. The read still
     * subscribes, and re-renders when the parent's fetch lands.
     *
     * A fetch loads the whole partition, which can be far larger than what one read selects: a player read names one
     * id, but `/players/{sport}` is the only endpoint, so it fetches a whole league. Fifty such reads on a screen would
     * be fifty requests for one league. Whether a caller should fetch depends on where it is called, which is why this
     * is a call option and not part of the read's definition. Only `false` is accepted: a caller can decline to fetch,
     * but cannot make a read fetch that is defined not to.
     */
    prime?: false;
}
/**
 * A declared read, callable as a hook or a getter. `undefined` args mean there is nothing to read yet, and it returns
 * `empty`.
 */
export interface Read<Args, T> {
    /**
     * The read's value from the rows already loaded, starting a fetch if the partition has never been fetched. Tracked: a
     * derivation that calls it re-runs when the value changes.
     */
    getValue: (args: Args | undefined) => T;
    /** The read's value as a hook, fetching the partition if needed and re-rendering when the value changes. */
    useValue: (args: Args | undefined, options?: ReadCallOptions) => DataResult<T>;
    /**
     * The args fields a caller must have before the read runs: the partition's fields plus its `varyBy` fields. Present
     * when both are field lists, which lets {@link pairRead} publish the read without the service repeating the list.
     */
    requires?: readonly string[];
}
/** Returns a {@link DataResult} whose identity is stable across renders while its parts hold. */
export declare function useResult<T>(data: T, status: DataStatus, isFetching: boolean, doRefetch: () => void): DataResult<T>;
/**
 * Builds the read engine over one store's partitions: `read` / `readMany` / `readGrouped` each take a descriptor and
 * hand back its `useValue` / `getValue` pair, with the priming, the version subscription, the presence gate and the
 * value cache already wrapped around `select`. `definePartitions` builds one per store, so stores declare reads.
 */
export declare function createReadSurface<Key>(kernel: ReadSurfaceKernel<Key>): {
    /**
     * Declares a read, in two calls: `read<Args, Value>()({ … })`. The first names what the read takes and returns, the
     * second takes the read itself — separately, because that is what leaves TypeScript free to infer `varyBy` from the
     * list a read spells, which is how `select` comes to see those fields and no others.
     */
    read: <Args, T>() => <const V extends VarySpec<Args> = readonly []>(def: ReadDef<Args, Key, T, V>) => Read<Args, T>;
    readMany: <Args, T>() => <const V extends VarySpec<Args> = readonly []>(def: ReadManyDef<Args, Key, T, V>) => Read<Args, T>;
    readGrouped: <Args, T>() => <const V extends VarySpec<Args> = readonly []>(def: ReadGroupedDef<Args, Key, T, V>) => Read<Args, T>;
    has: (key: Key) => boolean;
};
export {};
//# sourceMappingURL=surface.d.ts.map