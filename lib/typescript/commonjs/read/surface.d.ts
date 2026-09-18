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
    usePrime: (key: Key | undefined, enabled: boolean) => PrimeState;
    usePrimeMany: (keys: readonly Key[], enabled: boolean) => PrimeState;
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
     * What a read falls back on when it declares no `partition`: the store's key fields, or a function for a store
     * whose key arrives whole in one arg. Supplying the function promises every `read`'s args carry the key.
     */
    defaultPartition?: readonly string[] | ((args: never) => Key);
    /** The store's fetch ingest; a push-fed store omits it, and its empty partitions then read as `success`. */
    ingest?: FetchOwner<Key>;
}
/** A read's `varyBy`, either way it can be spelled: the args fields it names, or a value it computes from them. */
export type VarySpec<Args> = readonly VaryField<Args>[] | ((args: Args) => readonly VaryValue[]);
/**
 * What a read does about a partition holding no rows yet. Spelled as a word rather than `true` because the two
 * settings are not the same size of act: `'partition'` fetches the *whole* partition however little of it this read
 * goes on to select, which is the whole cost of a cold read and the thing a call site cannot see.
 */
export type PrimeSetting = 'partition' | false;
/**
 * Makes `prime` a required answer for a read that declares a `varyBy`, and leaves it optional otherwise.
 *
 * A `varyBy` is the read saying it wants a *slice* of its partition. That is exactly the shape where priming is a
 * gamble the declaration cannot settle on its own — a partition is as large as the store made it, and a read of
 * twenty ids out of a league's whole roster fetches the roster. A read with no `varyBy` wants the partition entire,
 * so priming it is plainly right and nothing is asked. This is a type-level question, not a rule: either answer is
 * fine, but a narrowing read has to have been asked it.
 */
export type PrimeChoice<Args, V extends VarySpec<Args>> = V extends readonly [] ? {
    prime?: PrimeSetting;
} : {
    prime: PrimeSetting;
};
/**
 * What a read's `select` is handed, which is the fields it named in `varyBy` and nothing else: reaching an arg the read
 * never declared is what would serve one caller's value to another, so it does not typecheck. Each field is
 * non-nullable, since the read does not run until every one has arrived. A `varyBy` computed by a function names no
 * fields to narrow to, so a read spelling it that way is handed the whole args and answers for them itself.
 */
export type SelectArgs<Args, V> = V extends readonly (keyof Args)[] ? {
    [K in V[number]]: NonNullable<Args[K & keyof Args]>;
} : Args;
interface CommonDef<Args, T, V extends VarySpec<Args>> {
    enabled?: (args: Args) => boolean;
    /**
     * Everything `select` reads beyond the partition itself, which together form the read's cache key. Must cover
     * every one of them; the read is off while any is absent (see `isVaryPresent`), and `select` sees only these.
     */
    varyBy?: V;
    /**
     * The args fields a caller must hold, for a read naming its partitions with a function, where they cannot be read
     * off a field list. This is what {@link Read.requires} carries, and so what lets {@link pairRead} publish the read.
     */
    requires?: readonly string[];
    /** Must be a stable reference — it is returned while loading and while disabled. */
    empty: T;
    /**
     * How this read's value is compared, both to hold its prior reference and to bail its readers out. Defaults to
     * {@link shallowEqualValue}, which covers a list or a record of reference-stable values; name one only where a
     * level deeper decides it, which is what {@link shallowEqualStruct} builds.
     */
    isEqual?: (left: T, right: T) => boolean;
    /** Sizes this read's value cache, keyed by partition and args together. Default 256, shared by every subscriber. */
    getCacheMax?: number;
    /**
     * Whether reading a cold partition fetches it. Defaults to `'partition'`; set `false` for a guess at partitions,
     * or a selector. A read declaring a `varyBy` must answer this rather than take the default — see
     * {@link PrimeChoice}, which is intersected onto the published signature and is where that requirement lives.
     */
    prime?: PrimeSetting;
}
/**
 * Declares a read of one partition, which is the shape nearly every read in a store has: a call's args name a single
 * address, and `select` works within it. Reach past it only when one call has to span several partitions at once:
 * `ReadManyDef` for a set of them, `ReadGroupedDef` when that set arrives as one group per thing the caller asks about.
 */
export interface ReadDef<Args, Key, T, V extends VarySpec<Args> = readonly []> extends CommonDef<Args, T, V> {
    /**
     * The args fields that spell the partition's key, or a function returning it, which may register it as a side
     * effect. Defaults to the store's key fields; a store whose key is opaque must pass the function.
     */
    partition?: readonly PartitionField<Args>[] | ((args: Args) => Key);
    /** Runs only once the partition holds rows. */
    select: (args: SelectArgs<Args, V>, key: Key) => T;
}
/**
 * Declares a read whose args resolve to a set of partitions rather than one, primed and subscribed together and read
 * as a single value — a list gathered across addresses, or several candidates for one answer. `select` is handed the
 * keys flat, so use `ReadGroupedDef` instead when the caller asks about several things, each with its own candidates.
 */
export interface ReadManyDef<Args, Key, T, V extends VarySpec<Args> = readonly []> extends CommonDef<Args, T, V> {
    /** May register the partitions as a side effect. A key that addresses nothing keeps its slot as a gap. */
    partitions: (args: Args) => readonly Key[];
    select: (args: SelectArgs<Args, V>, keys: readonly Key[]) => T;
}
/**
 * Declares one read over several things at once, each carrying its own candidate partitions — the plural of a
 * `ReadManyDef` whose keys are candidates for one answer. `select` gets the groups back in the order it named them,
 * so the read answers per thing rather than flattening every candidate into one set and re-slicing it by index.
 */
export interface ReadGroupedDef<Args, Key, T, V extends VarySpec<Args> = readonly []> extends CommonDef<Args, T, V> {
    /** One group of candidate partitions per thing the caller asks about. Their union is subscribed and primed. */
    groups: (args: Args) => readonly (readonly Key[])[];
    /** Handed the groups back in the order they were named. */
    select: (args: SelectArgs<Args, V>, groups: readonly (readonly Key[])[]) => T;
}
/**
 * What one call site says about a read, as against what its declaration fixes: `enabled` switches this caller's read
 * and its priming off while its hooks stay mounted, for a screen holding args it should not be reading on yet.
 */
export interface ReadCallOptions {
    enabled?: boolean;
}
/**
 * A read as a store publishes it: `undefined` args mean there is nothing to read yet, so it returns `empty`. Its
 * members are properties, so a backend's reads are checked contravariantly against them.
 */
export interface Read<Args, T> {
    getValue: (args: Args | undefined) => T;
    useValue: (args: Args | undefined, options?: ReadCallOptions) => DataResult<T>;
    /**
     * The args fields a caller must have in hand before this read addresses anything: the partition's fields plus
     * everything it varies by. Present when both are declared as field lists, which is what lets {@link pairRead}
     * publish the read without a service restating the list.
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
    read: <Args, T>() => <const V extends VarySpec<Args> = readonly []>(def: ReadDef<Args, Key, T, V> & PrimeChoice<Args, V>) => Read<Args, T>;
    readMany: <Args, T>() => <const V extends VarySpec<Args> = readonly []>(def: ReadManyDef<Args, Key, T, V> & PrimeChoice<Args, V>) => Read<Args, T>;
    readGrouped: <Args, T>() => <const V extends VarySpec<Args> = readonly []>(def: ReadGroupedDef<Args, Key, T, V> & PrimeChoice<Args, V>) => Read<Args, T>;
    has: (key: Key) => boolean;
};
export {};
//# sourceMappingURL=surface.d.ts.map