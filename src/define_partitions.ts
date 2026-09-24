/**
 * A store's rows divided into partitions: the addressable slice a fetch replaces, a version tracks, and an ETag
 * belongs to. From `key.where` alone this derives presence, what a fetch replaces, where the ETag lives, and what
 * a write bumps.
 */

import { useCallback } from 'react';

import { cacheKey, partitionLabel, cacheKeyOf } from './args_key';
import { createFetchIngest, FetchIngest, RawQuery } from './write/fetch_ingest';
import { createReadSurface, Read, ReadDef, ReadGroupedDef, ReadManyDef, useResult, VarySpec } from './read/surface';
import { RowShape, RowTable } from './table/types';
import { BoundMemos, createBoundedLru, createMemos, MemoDeclaration } from './caches';
import { addressesPartition, NO_PARTS, VersionAtom } from './reactivity/version_atom';
import { PartitionField, partitionKeyOf } from './read/partition_fields';
import { createRowProjection, RowProjection, RowProjectionDef, rowVmMemo, RowVmMemo } from './read/projection';
import { NO_PRIMING, PrimeState } from './prime_state';
import { DataResult, offHeapStatus } from './store_result';
import { reportStoreDegradation } from './diagnostics/telemetry';
import { runSubscribed } from './reactivity/tracking';
import type { Loose } from './read/facade';
import { ALL_UNITS, ChangeSet, isUnchanged, WriteResult } from './table/change_set';

/** No partition: args still being filled in, or a slot a caller left empty, which keeps its index in the result. */
type MaybePartition<Descriptor> = Descriptor | null | undefined;

/**
 * How a store gets from a read's args to the partition they name. Either `fields` lists the args fields that make the
 * key, or `of` and `id` turn the args into a partition record and the record into a key — for a record too big to be
 * a key itself, which the kernel remembers so a fetch can get it back.
 */
export interface PartitionKeySpec<Row extends RowShape, Key, Args, Descriptor> {
  /**
   * The args fields that make up the key, in order. Two args with the same values in these fields name one partition.
   */
  fields?: readonly (keyof Key & string)[];
  /**
   * The partition record a read's args name, used with `id` instead of `fields`. Args arrive as loosely as a screen
   * holds them, so return nothing while one is still missing a value: that reads and fetches nothing, the same as a
   * missing field.
   */
  of?: (args: Loose<Args>) => MaybePartition<Descriptor>;
  /** The key for a partition record. Must be stable, and different records must never share one. */
  id?: (descriptor: Descriptor) => Key;
  /**
   * The partition record for a key, the reverse of {@link id}, for a store whose keys can be parsed. Worth supplying:
   * the kernel remembers only so many record⇄key pairs, and without this a partition it forgot cannot be fetched again
   * for the life of the process. With it, forgetting costs a parse.
   */
  from?: (key: Key) => MaybePartition<Descriptor>;
  /** The table rows one partition holds, as column values to match. */
  where: (key: Key) => Partial<Row>;
}

/** How a partition's rows are fetched. Omit it for a store fed only by pushes. */
export interface PartitionFetchSpec<Row extends RowShape, Key, Descriptor> {
  /** The request that fetches one partition, sending `etag` as `If-None-Match` when the kernel has one. */
  query: (partition: Descriptor, etag?: string) => RawQuery;
  /** Turns a response body into the partition's rows. They replace everything the partition held. */
  parse: (partition: Descriptor, rawJson: string, key: Key) => readonly Row[];
  /**
   * Whether this partition's body can go through the native shred, which needs a top-level JSON array. True by default.
   */
  canShredNatively?: (partition: Descriptor) => boolean;
  /**
   * Holds pushed writes to the partition while its fetch is in flight, and returns the function that releases them,
   * so a push landing mid-fetch is not wiped out by the replace.
   */
  holdWrites?: (key: Key) => () => void;
}

/**
 * A store's partitions: the table they divide, the version they bump, how to find a partition's rows, and how to fetch
 * them.
 */
export interface PartitionsConfig<Row extends RowShape, Key, Args, Descriptor> {
  /** The store's name, used in cache keys, logs and error reports. */
  name: string;
  /** The row table the partitions divide. */
  table: RowTable<Row>;
  /** The version store the partitions bump when their rows change, which is what re-renders their readers. */
  version: VersionAtom;
  /** How a read's args name a partition, and which rows it holds. */
  key: PartitionKeySpec<Row, Key, Args, Descriptor>;
  /** How a partition is fetched; omit it for a store fed only by pushes. */
  fetch?: PartitionFetchSpec<Row, Key, Descriptor>;
  /**
   * Runs after a write changes a partition, with its new version and the units that changed; never for a write that
   * changed nothing. For a store holding something derived from a partition, such as a ranking, that new rows make
   * stale.
   */
  onChanged?: (key: Key, version: number, changes: ChangeSet) => void;
  /** How many partitions to remember record⇄key pairs and fetch times for; 512 by default. */
  internMax?: number;
}

/** Options for a priming hook. */
export interface PrimeHookOptions {
  /** Set false to fetch nothing while keeping the hook's position; true by default. */
  enabled?: boolean;
}

/** Options for `usePrimeAndVersion`. */
export interface PrimeAndVersionOptions extends PrimeHookOptions {
  /** Set false to keep subscribing to the version without fetching the partition. */
  prime?: false;
}

/** Options for an imperative fetch. */
export interface FetchOptions {
  /**
   * How old, in ms, the partition's rows may be before this fetches them again; the partition query's own by default.
   */
  staleTime?: number;
}

/**
 * The partition operations a store publishes for callers outside the read path. Each takes the same args a read does.
 * The hooks take them loosely, as a screen holds them, and can be called unconditionally: args still missing the
 * value that names a partition fetch nothing.
 */
interface PartitionLifecycle<Args> {
  /** Starts fetching the partition if it is not fresh. `undefined` args keep the hook's position and fetch nothing. */
  usePrime: (args: Loose<Args> | undefined, options?: PrimeHookOptions) => PrimeState;
  /** Starts fetching each partition that is not fresh, in one hook. */
  usePrimeMany: (args: readonly Args[], options?: PrimeHookOptions) => PrimeState;
  /**
   * The partition's version as a `DataResult`, fetching the partition as a read would. For a derivation that reads the
   * store imperatively and needs something to re-render on.
   */
  usePrimeAndVersion: (args: Loose<Args> | undefined, options?: PrimeAndVersionOptions) => DataResult<number>;
  /** Whether the partition holds any rows. Tracked: a derivation that calls it re-runs when that changes. */
  has: (args: Args) => boolean;
  /** The partition's version, which goes up on every write that changes it; 0 if never written. Tracked. */
  getVersion: (args: Args) => number;
  /** When a fetch last brought the partition rows, in epoch ms; 0 if never. Tracked. */
  getFetchedAt: (args: Args) => number;
  /** Fetches the partition unless it is fresh or already in flight, resolving once its rows have landed. */
  fetch: (args: Args, options?: FetchOptions) => Promise<void>;
  /** Fetches the partition again, however fresh it is. */
  refetch: (args: Args) => void;
  /** Marks the partition stale: fetched again at once if a screen is reading it, otherwise by its next reader. */
  invalidate: (args: Args) => void;
  /**
   * Forgets every partition's fetch history, so each reads as never fetched. Used when a store moves to another
   * database.
   */
  forget: () => void;
}

/** Args that carry the read's partitions in the field of that name, where `readMany` looks by default. */
interface NamesPartitions<Descriptor> {
  partitions: readonly MaybePartition<Descriptor>[];
}

/** Where a read's partitions come from; `null` and `undefined` both stand for an empty set. */
type PartitionsFrom<Args, Descriptor> = (args: Args) => readonly MaybePartition<Descriptor>[] | null | undefined;

/** `readMany`, naming its partitions as the records a caller holds. Optional when the args already carry them. */
type PartitionReadManyDef<Args, Key, T, Descriptor, V extends VarySpec<Args>> = Omit<ReadManyDef<Args, Key, T, V>, 'partitions'> &
  (Args extends NamesPartitions<Descriptor> ? { partitions?: PartitionsFrom<Args, Descriptor> } : { partitions: PartitionsFrom<Args, Descriptor> });

/** `readGrouped`, likewise: one group of candidate records per thing the caller is asking about. */
interface PartitionReadGroupedDef<Args, Key, T, Descriptor, V extends VarySpec<Args>> extends Omit<ReadGroupedDef<Args, Key, T, V>, 'groups'> {
  /** One group of candidate partitions per thing the caller asks about, such as each stat key's possible partitions. */
  groups: (args: Args) => readonly (readonly MaybePartition<Descriptor>[])[];
}

/**
 * What `definePartitions` gives a store's `build`: functions to declare reads and view models with, lower-level access
 * to rows and versions for the store's own code, and a `lifecycle` group to publish.
 */
export interface Partitions<Row extends RowShape, Key, Args, Descriptor> {
  /**
   * Declares a read over one partition, in two calls: `read<Args, Value>()({ … })`. The first names what the read takes
   * and returns; the second takes the read's definition. It is split so TypeScript can infer `varyBy` from the list the
   * read spells, which is what limits `select` to exactly those fields.
   */
  read: <A extends Args, T>() => <const V extends VarySpec<A> = readonly []>(def: ReadDef<A, Key, T, V>) => Read<A, T>;
  /** Declares a read over several partitions at once, one result per partition, in the same two calls as `read`. */
  readMany: <A, T>() => <const V extends VarySpec<A> = readonly []>(def: PartitionReadManyDef<A, Key, T, Descriptor, V>) => Read<A, T>;
  /**
   * Declares a read over groups of candidate partitions, one group per thing the caller asks about; `select` gets them
   * back in those groups. For a lookup that could live in any of several partitions.
   */
  readGrouped: <A, T>() => <const V extends VarySpec<A> = readonly []>(def: PartitionReadGroupedDef<A, Key, T, Descriptor, V>) => Read<A, T>;
  /**
   * Declares the store's memoized values in one block, each cached per partition and dropped when the partition
   * changes. A memo takes a partition key and the thing it wants; it works out its own cache key and version. See
   * {@link createMemos}.
   */
  memos: <D extends Record<string, MemoDeclaration>>(decls: D) => BoundMemos<Key, D>;
  /**
   * Declares a view model built from one unit's rows, in two calls like the reads: `project<Vm>()({ … })`. Every read
   * returning that shape goes through it, so a unit is built once however many reads ask, and a write rebuilds only the
   * units it changed. See {@link createRowProjection}.
   */
  project: <Vm>() => (def: RowProjectionDef<Row, Vm>) => RowProjection<Key, Row, Vm>;
  /** The table rows one partition holds, as column values to match: the store's own `key.where`. */
  where: (key: Key) => Partial<Row>;
  /** The key for a partition record, remembering the pair so a fetch can get the record back. */
  keyOf: (partition: Descriptor) => Key;
  /** Every remembered key, least- to most-recently used. */
  internedKeys: () => IterableIterator<Key>;
  /** Whether the partition holds any rows. Tracked: a derivation that calls it re-runs when that changes. */
  has: (key: Key) => boolean;
  /** The partition's version, which goes up on every write that changes it; 0 if never written. Tracked. */
  versionOf: (key: Key) => number;
  /**
   * Raises the partition's version and runs `onChanged`, for a store that wrote rows itself. Pass the units its write
   * changed; without them every unit counts as changed, and a write that changed nothing bumps nothing.
   */
  bump: (key: Key, changes?: ChangeSet) => number;
  /** Drops the partition's stored ETag, so its next fetch returns a full body rather than a 304. */
  clearEtag: (key: Key) => void;
  /** The partition operations for callers outside the read path, ready to publish as-is. */
  lifecycle: PartitionLifecycle<Args>;
}

const INTERN_MAX = 512;
const NO_INTERNED: readonly never[] = Object.freeze([]);
/** The empty descriptor list `readMany` falls back on when args name no partitions. */
const NO_DESCRIPTORS: readonly never[] = Object.freeze([]);

/**
 * Divides a store's table into partitions — the slice one fetch replaces, one version tracks, and one ETag belongs to —
 * and returns the reads, view models, fetching and version bumps built on them. The store supplies where a
 * partition's rows are (`key.where`) and how a response becomes them (`fetch`). Call it from a store's `build`, after
 * `table.init()`.
 */
export function definePartitions<Row extends RowShape, Key, Args = Key, Descriptor = Args>(
  config: PartitionsConfig<Row, Key, Args, Descriptor>,
): Partitions<Row, Key, Args, Descriptor> {
  const { name, table, version, key: keySpec, fetch: fetchSpec } = config;
  const where = keySpec.where;

  /** A key's parts: its positional form, which reaches only as far as the version and query keys. */
  const fields = keySpec.fields;
  const toParts: (key: Key) => readonly string[] = !fields
    ? (key) => [(key as unknown as string) ?? '']
    : fields.length === 1
    ? (key) => [(key as Record<string, string>)[fields[0]] ?? '']
    : (key) => fields.map((field) => (key as Record<string, string>)[field] ?? '');

  /** The record⇄key mapping. Bounded; every path to a key re-registers, so a live partition's entry stays warm. */
  const toId = keySpec.id;
  const interned = toId ? createBoundedLru<Descriptor>(config.internMax ?? INTERN_MAX) : undefined;
  const keyOf = (partition: Descriptor): Key => {
    if (!toId || !interned) return partition as unknown as Key;
    const key = toId(partition);
    interned.set(key as unknown as string, partition);
    return key;
  };
  /** The key an absent partition maps to: all-empty parts, which `addressesPartition` rejects, so nothing is read or primed. */
  const GAP_KEY = (fields ? Object.freeze({}) : '') as unknown as Key;
  const keyOfMaybe = (partition: MaybePartition<Descriptor>): Key => (partition == null ? GAP_KEY : keyOf(partition));

  const describe = (key: Key): Descriptor => {
    if (!interned) return key as unknown as Descriptor;
    const partition = interned.get(key as unknown as string);
    if (partition) return partition;

    // Evicted, so re-derive it if the store can. Re-interned on the way past, since something is asking about
    // this partition again and the next ask should be a hit.
    const reparsed = keySpec.from?.(key);
    if (reparsed != null) {
      interned.set(key as unknown as string, reparsed);
      return reparsed;
    }

    // Nothing else in the kernel fails a read outright, and this is the one bound that can. A store whose keys
    // are parseable should declare `from`; one whose keys are not needs a larger `internMax`.
    reportStoreDegradation({
      scope: `partitions.intern_evicted.${name}`,
      context: `${name}_store: partition ${String(key)} left the key table, so it cannot be addressed again`,
      extra: { internMax: config.internMax ?? INTERN_MAX },
    });
    throw new Error(`${name}_store: unknown partition ${String(key)}`);
  };

  /** How a read and every `lifecycle` member gets from args to the key; `key.of` reads them at their loosest. */
  const keyOfArgs: (args: Args) => Key = keySpec.of
    ? (args) => keyOfMaybe(keySpec.of!(args as Loose<Args>))
    : !fields
    ? (args) => args as unknown as Key
    : // The fields are named against `Key` and here pick out of `Args`, which `defaultPartition` already requires.
      partitionKeyOf<Args, Key>(fields as unknown as readonly PartitionField<Args>[]);

  const bump = (key: Key, changes: ChangeSet = ALL_UNITS): number => {
    const parts = toParts(key);
    if (isUnchanged(changes)) return version.get(parts);
    const next = version.bump(parts, changes);
    config.onChanged?.(key, next, changes);
    return next;
  };

  /** When each partition's rows last landed. Bounded, and a forgotten timestamp reads as never-fetched. */
  const fetchedAt = createBoundedLru<number>(config.internMax ?? INTERN_MAX);

  /** Replaces the partition's rows, through the native shred where the body allows it and JS parsing otherwise. */
  async function ingestRaw(key: Key, rawJson: string): Promise<WriteResult> {
    const spec = fetchSpec as PartitionFetchSpec<Row, Key, Descriptor>;
    const partition = describe(key);
    const rowsWhere = where(key);
    const parse = (raw: string): Row[] => spec.parse(partition, raw, key) as Row[];
    const inJs = (): WriteResult => table.overwrite(rowsWhere, parse(rawJson));

    let result: WriteResult;
    if (spec.canShredNatively?.(partition) === false) {
      result = inJs();
    } else {
      try {
        result = await table.shred(rowsWhere, rawJson, parse);
      } catch (error) {
        reportStoreDegradation({
          scope: `${name}_store.raw_ingest`,
          context: 'async raw ingest failed; re-parsed and retried through the synchronous path',
          error,
          extra: { store: name, partition: partitionLabel(toParts(key)) },
        });
        result = inJs();
      }
    }
    fetchedAt.set(cacheKeyOf(toParts(key)), Date.now());
    return result;
  }

  const ingest: FetchIngest<Key> | undefined = fetchSpec
    ? createFetchIngest<Key>({
        ingestKeyRoot: `${name}_store_ingest`,
        version,
        toParts,
        rawQuery: interned ? (key, etag) => fetchSpec.query(describe(key), etag) : (fetchSpec.query as unknown as (key: Key, etag?: string) => RawQuery),
        getEtag: (key) => table.getMeta(where(key)),
        setEtag: (key, etag) => table.setMeta(where(key), etag),
        ingestRaw,
        bump,
        holdWrites: fetchSpec.holdWrites,
      })
    : undefined;

  const surface = createReadSurface<Key>({
    name,
    version,
    toParts,
    has: (key) => table.has(where(key)),
    hasFetched: (key) => fetchedAt.get(cacheKeyOf(toParts(key))) !== undefined,
    defaultPartition: keySpec.of ? (keyOfArgs as (args: never) => Key) : fields,
    ingest,
  });

  /** Whether the partition holds rows. Tracks, since the surface's probe takes the version on every call. */
  const has = (key: Key): boolean => surface.has(key);
  const versionOf = (key: Key): number => version.get(toParts(key));
  /** What every memo this store declares is bound by: a partition's version, and each unit's. */
  const memoBinding = { parts: toParts, version: versionOf, unitVersion: (key: Key, unit: string) => version.getUnit(toParts(key), unit) };

  // Bound once, so the hook a component calls is the same one on every render.
  const usePriming = ingest?.usePrime ?? NO_PRIMING;
  const usePrimingAll = ingest?.usePrimeMany ?? NO_PRIMING;

  /**
   * The key a priming hook's args address. Args short of a value are `keyOfArgs`' business as usual: a missing field
   * becomes an empty part and `key.of` answers `null`, and either way `addressesPartition` rejects the key, so nothing is primed.
   */
  const keyOfHookArgs = (args: Loose<Args>): Key => keyOfArgs(args as Args);

  function usePrimeAndVersion(args: Loose<Args> | undefined, options?: { enabled?: boolean; prime?: false }): DataResult<number> {
    const key = args === undefined ? undefined : keyOfHookArgs(args);
    const parts = key === undefined ? NO_PARTS : toParts(key);
    const isEnabled = (options?.enabled ?? true) && key !== undefined && addressesPartition(parts);
    // `prime: false` keeps the version subscription and drops only the fetch, the same split `ReadCallOptions` makes.
    const prime = usePriming(key, isEnabled && options?.prime !== false);
    const ver = version.useVersion(parts, isEnabled);
    const partsKey = cacheKeyOf(parts);
    const status = runSubscribed(() => offHeapStatus(isEnabled, isEnabled && surface.has(key as Key), prime));
    const doRefetch = useCallback(() => {
      if (key !== undefined) ingest?.refetch(key);
    }, [partsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `partsKey` covers `key`
    return useResult(ver, status, prime.isFetching, doRefetch);
  }

  /** Both set reads name their partitions as records; the keys they address are this layer's to resolve. */
  function readManyOf<A, T>() {
    return <const V extends VarySpec<A> = readonly []>(def: PartitionReadManyDef<A, Key, T, Descriptor, V>): Read<A, T> => {
      const named = (def as { partitions?: PartitionsFrom<A, Descriptor> }).partitions ?? ((args) => (args as NamesPartitions<Descriptor>).partitions);
      return surface.readMany<A, T>()({ ...def, partitions: (args: A) => (named(args) ?? NO_DESCRIPTORS).map(keyOfMaybe) } as ReadManyDef<A, Key, T, V>);
    };
  }

  function readGroupedOf<A, T>() {
    return <const V extends VarySpec<A> = readonly []>(def: PartitionReadGroupedDef<A, Key, T, Descriptor, V>): Read<A, T> => {
      const groups = (args: A) => def.groups(args).map((group) => group.map(keyOfMaybe));
      return surface.readGrouped<A, T>()({ ...def, groups } as ReadGroupedDef<A, Key, T, V>);
    };
  }

  return {
    read: surface.read,
    readMany: readManyOf,
    readGrouped: readGroupedOf,
    memos: (decls) => createMemos(name, memoBinding, decls),
    project:
      <Vm,>() =>
      (def: RowProjectionDef<Row, Vm>) => {
        const bound = createMemos(name, memoBinding, { [def.name]: rowVmMemo<Vm>(def.max) });
        return createRowProjection<Row, Key, Vm>(
          { store: name, table, filter: where, memo: bound[def.name] as RowVmMemo<Key, Vm>, trackPartition: versionOf },
          def,
        );
      },
    where,
    keyOf,
    internedKeys: () => (interned ? (interned.keys() as IterableIterator<Key>) : NO_INTERNED[Symbol.iterator]()),
    has,
    versionOf,
    bump,
    clearEtag: (key) => table.setMeta(where(key), undefined),
    lifecycle: {
      usePrime: (args, options) => usePriming(args === undefined ? undefined : keyOfHookArgs(args), options?.enabled ?? true),
      usePrimeMany: (args, options) => usePrimingAll(args.map(keyOfArgs), options?.enabled ?? true),
      usePrimeAndVersion,
      has: (args) => has(keyOfArgs(args)),
      getVersion: (args) => versionOf(keyOfArgs(args)),
      getFetchedAt: (args) => {
        const parts = toParts(keyOfArgs(args));
        // Read for its tracking side effect, so a derivation gating on this getter hears about the change.
        version.get(parts);
        return fetchedAt.get(cacheKeyOf(parts)) ?? 0;
      },
      fetch: (args, options) => (ingest ? ingest.prefetch(keyOfArgs(args), options).then(() => undefined) : Promise.resolve()),
      refetch: (args) => ingest?.refetch(keyOfArgs(args)),
      invalidate: (args) => ingest?.invalidate(keyOfArgs(args)),
      forget: () => ingest?.forget(),
    },
  };
}
