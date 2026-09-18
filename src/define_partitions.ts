/**
 * A store's rows divided into partitions: the addressable slice a fetch replaces, a version tracks, and an ETag
 * belongs to. From `key.where` alone this derives presence, what a fetch replaces, where the ETag lives, and what
 * a write bumps.
 */

import { useCallback } from 'react';

import { cacheKey, partitionLabel } from './args_key';
import { createFetchIngest, FetchIngest, RawQuery } from './write/fetch_ingest';
import { createReadSurface, PrimeChoice, Read, ReadDef, ReadGroupedDef, ReadManyDef, useResult, VarySpec } from './read/surface';
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
  usePrime: (args: Loose<Args> | undefined, options?: { enabled?: boolean }) => PrimeState;
  usePrimeMany: (args: readonly Args[], options?: { enabled?: boolean }) => PrimeState;
  /** The version as a `DataResult`, primed as a read would, for a derivation that then reads imperatively. */
  usePrimeAndVersion: (args: Loose<Args> | undefined, options?: { enabled?: boolean }) => DataResult<number>;
  /** Whether the partition holds rows. Tracks. */
  has: (args: Args) => boolean;
  /** The partition's version, 0 if never written. Tracks. */
  getVersion: (args: Args) => number;
  /** When rows last landed, epoch ms, 0 if never; only a body that lands moves it. Tracks. */
  getFetchedAt: (args: Args) => number;
  fetch: (args: Args, options?: { staleTime?: number }) => Promise<void>;
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
type PartitionReadManyDef<Args, Key, T, Descriptor, V extends VarySpec<Args>> = Omit<ReadManyDef<Args, Key, T, V>, 'partitions'> &
  (Args extends NamesPartitions<Descriptor> ? { partitions?: PartitionsFrom<Args, Descriptor> } : { partitions: PartitionsFrom<Args, Descriptor> });

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
  read: <A extends Args, T>() => <const V extends VarySpec<A> = readonly []>(def: ReadDef<A, Key, T, V> & PrimeChoice<A, V>) => Read<A, T>;
  readMany: <A, T>() => <const V extends VarySpec<A> = readonly []>(
    def: PartitionReadManyDef<A, Key, T, Descriptor, V> & PrimeChoice<A, V>,
  ) => Read<A, T>;
  /** One group of candidates per thing the caller asks about; `select` gets them back in those groups. */
  readGrouped: <A, T>() => <const V extends VarySpec<A> = readonly []>(
    def: PartitionReadGroupedDef<A, Key, T, Descriptor, V> & PrimeChoice<A, V>,
  ) => Read<A, T>;
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

const INTERN_MAX = 512;
const NO_INTERNED: readonly never[] = Object.freeze([]);
/** The empty descriptor list `readMany` falls back on when args name no partitions. */
const NO_DESCRIPTORS: readonly never[] = Object.freeze([]);

/**
 * The middle layer of a store, and the call its backend is built around: answer where one partition's rows live
 * (`key.where`) and how a response body becomes them (`fetch`), and get back the reads, the ETag handling, the priming
 * and the version bumps derived from those answers. Called once per store, from `buildXBackend` after `table.init()`.
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
    if (!partition) throw new Error(`${name}_store: unknown partition ${String(key)}`);
    return partition;
  };

  /** How a read and every `lifecycle` member gets from args to the key; `key.of` reads them at their loosest. */
  const keyOfArgs: (args: Args) => Key = keySpec.of
    ? (args) => keyOfMaybe(keySpec.of!(args as Loose<Args>))
    : !fields
    ? (args) => args as unknown as Key
    : // The fields are named against `Key` and here pick out of `Args`, which `defaultPartition` already requires.
      partitionKeyOf<Args, Key>(fields as unknown as readonly PartitionField<Args>[]);

  const bump = (key: Key): number => {
    const next = version.bump(toParts(key));
    config.onChanged?.(key, next);
    return next;
  };

  /** When each partition's rows last landed. Bounded, and a forgotten timestamp reads as never-fetched. */
  const fetchedAt = createBoundedLru<number>(config.internMax ?? INTERN_MAX);

  /** Replaces the partition's rows, through the native shred where the body allows it and JS parsing otherwise. */
  async function ingestRaw(key: Key, rawJson: string): Promise<number> {
    const spec = fetchSpec as PartitionFetchSpec<Row, Key, Descriptor>;
    const partition = describe(key);
    const rowsWhere = where(key);
    const parse = (raw: string): Row[] => spec.parse(partition, raw, key) as Row[];
    const inJs = (): number => table.overwrite(rowsWhere, parse(rawJson));

    let count: number;
    if (spec.canShredNatively?.(partition) === false) {
      count = inJs();
    } else {
      try {
        count = await table.shred(rowsWhere, rawJson, parse);
      } catch (error) {
        reportStoreDegradation({
          scope: `${name}_store.raw_ingest`,
          context: 'async raw ingest failed; re-parsed and retried through the synchronous path',
          error,
          extra: { store: name, partition: partitionLabel(toParts(key)) },
        });
        count = inJs();
      }
    }
    fetchedAt.set(cacheKey(...toParts(key)), Date.now());
    return count;
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
    defaultPartition: keySpec.of ? (keyOfArgs as (args: never) => Key) : fields,
    ingest,
  });

  /** Whether the partition holds rows. Tracks, since the surface's probe takes the version on every call. */
  const has = (key: Key): boolean => surface.has(key);
  const versionOf = (key: Key): number => version.get(toParts(key));

  // Bound once, so the hook a component calls is the same one on every render.
  const usePriming = ingest?.usePrime ?? NO_PRIMING;
  const usePrimingAll = ingest?.usePrimeMany ?? NO_PRIMING;

  /**
   * The key a priming hook's args address. Args short of a value are `keyOfArgs`' business as usual: a missing field
   * becomes an empty part and `key.of` answers `null`, and either way `addressesPartition` rejects the key, so nothing is primed.
   */
  const keyOfHookArgs = (args: Loose<Args>): Key => keyOfArgs(args as Args);

  function usePrimeAndVersion(args: Loose<Args> | undefined, options?: { enabled?: boolean }): DataResult<number> {
    const key = args === undefined ? undefined : keyOfHookArgs(args);
    const parts = key === undefined ? NO_PARTS : toParts(key);
    const isEnabled = (options?.enabled ?? true) && key !== undefined && addressesPartition(parts);
    const prime = usePriming(key, isEnabled);
    const ver = version.useVersion(parts, isEnabled);
    const partsKey = cacheKey(...parts);
    const status = runSubscribed(() => offHeapStatus(isEnabled, isEnabled && surface.has(key as Key), prime));
    const doRefetch = useCallback(() => {
      if (key !== undefined) ingest?.refetch(key);
    }, [partsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `partsKey` covers `key`
    return useResult(ver, status, prime.isFetching, doRefetch);
  }

  /** Both set reads name their partitions as records; the keys they address are this layer's to resolve. */
  function readManyOf<A, T>() {
    return <const V extends VarySpec<A> = readonly []>(def: PartitionReadManyDef<A, Key, T, Descriptor, V> & PrimeChoice<A, V>): Read<A, T> => {
      const named = (def as { partitions?: PartitionsFrom<A, Descriptor> }).partitions ?? ((args) => (args as NamesPartitions<Descriptor>).partitions);
      // `def` already carries whatever `prime` the published signature demanded of the caller, and this layer only
      // rewrites `partitions`. So it forwards through the unconstrained shape: restating the conditional here asks
      // TypeScript to compare a `PrimeChoice` it cannot resolve while `V` is still generic.
      const publish = surface.readMany<A, T>() as (def: ReadManyDef<A, Key, T, V>) => Read<A, T>;
      return publish({ ...def, partitions: (args: A) => (named(args) ?? NO_DESCRIPTORS).map(keyOfMaybe) } as ReadManyDef<A, Key, T, V>);
    };
  }

  function readGroupedOf<A, T>() {
    return <const V extends VarySpec<A> = readonly []>(def: PartitionReadGroupedDef<A, Key, T, Descriptor, V> & PrimeChoice<A, V>): Read<A, T> => {
      const groups = (args: A) => def.groups(args).map((group) => group.map(keyOfMaybe));
      // Forwarded unconstrained for the same reason as `readManyOf` above.
      const publish = surface.readGrouped<A, T>() as (def: ReadGroupedDef<A, Key, T, V>) => Read<A, T>;
      return publish({ ...def, groups } as ReadGroupedDef<A, Key, T, V>);
    };
  }

  return {
    read: surface.read,
    readMany: readManyOf,
    readGrouped: readGroupedOf,
    memos: (decls) => createMemos(name, { parts: toParts, version: versionOf }, decls),
    project:
      <Vm,>() =>
      (def: RowProjectionDef<Row, Vm>) => {
        const bound = createMemos(name, { parts: toParts, version: versionOf }, { [def.name]: rowVmMemo<Vm>(def.max) });
        return createRowProjection<Row, Key, Vm>(
          { store: name, table, filter: where, memo: bound[def.name] as RowVmMemo<Key, Vm> },
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
        return fetchedAt.get(cacheKey(...parts)) ?? 0;
      },
      fetch: (args, options) => (ingest ? ingest.prefetch(keyOfArgs(args), options).then(() => undefined) : Promise.resolve()),
      refetch: (args) => ingest?.refetch(keyOfArgs(args)),
      invalidate: (args) => ingest?.invalidate(keyOfArgs(args)),
      forget: () => ingest?.forget(),
    },
  };
}
