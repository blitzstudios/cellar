/**
 * Turns one read declaration into a store's `useValue` (reactive) and `getValue` (imperative) pair.
 * `read` is scoped to one partition; `readMany` spans a variable set of them.
 */

import { useCallback, useMemo } from 'react';

import { cacheKey, EMPTY_VARY, isVaryPresent, KEY_SEP, partitionsKey, VaryValue, varyKey, cacheKeyOf } from '../args_key';
import { getOrCreate } from '../collections';
import { PartitionField, partitionKeyOf, requiredFieldsOf, VaryField, varyValuesOf } from './partition_fields';
import { createTrackedCache, createVersionedCache, shallowEqualValue } from '../caches';
import { addressesPartition, NO_PARTS, PartitionEntry, partitionEntries, VersionAtom } from '../reactivity/version_atom';
import { createOnceGuard, onGuardReset } from '../diagnostics/once_guard';
import { shouldLog } from '../diagnostics/log_level';
import { NO_PRIMING, type PrimeState } from '../prime_state';
import { DataResult, DataStatus, makeResult, offHeapStatus } from '../store_result';
import { runSubscribed, runTracked, trackDependency } from '../reactivity/tracking';
import { useTrackedValue } from '../reactivity/tracked_value';
import { covered, uncoveredReads } from '../table/read_coverage';

/** The fetch half of a store as a read sees it, which `createFetchIngest`'s return value satisfies. */
export interface FetchOwner<Key> {
  usePrime: (key: Key | undefined, enabled: boolean, opts?: { slice?: boolean }) => PrimeState;
  usePrimeMany: (keys: readonly Key[], enabled: boolean, opts?: { slice?: boolean }) => PrimeState;
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

/** A read's `varyBy`, either way it can be spelled: the args fields it names, or a value it computes from them. */
export type VarySpec<Args> = readonly VaryField<Args>[] | ((args: Args) => readonly VaryValue[]);


/**
 * What a read's `select` is handed, which is the fields it named in `varyBy` and nothing else: reaching an arg the read
 * never declared is what would serve one caller's value to another, so it does not typecheck. Each field is
 * non-nullable, since the read does not run until every one has arrived. A `varyBy` computed by a function names no
 * fields to narrow to, so a read spelling it that way is handed the whole args and answers for them itself.
 */
export type SelectArgs<Args, V> = V extends readonly (keyof Args)[] ? { [K in V[number]]: NonNullable<Args[K & keyof Args]> } : Args;

/**
 * Hands `select` the whole args object, which carries the fields it declared and others it cannot see. Sound because
 * the narrowing exists to stop a store *writing* a reach into an undeclared arg, not to hide anything at runtime.
 */
function overArgs<Args, Named, T, V>(select: (args: SelectArgs<Args, V>, named: Named) => T): (args: Args, named: Named) => T {
  return select as unknown as (args: Args, named: Named) => T;
}

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
   * Whether reading a cold partition fetches it. Default true; set false for a guess at partitions, or a selector.
   *
   * Note what priming is scoped to, because it is not what a read selects: it fetches the whole PARTITION, so a
   * read narrowing within a large one pays for all of it. That is a property of the store's fetch granularity
   * rather than of this read, and the setting cannot improve it — where it bites, the fix is at the call site
   * (prefer a payload that already carries the rows) or in the store's partition key. An ingest large enough to be
   * worth knowing about reports itself once per session; see `reportOversizedPrime`.
   */
  prime?: boolean;
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
  /**
   * `false` to read without fetching, for a caller whose parent already primes the partition. The rows still arrive —
   * the read subscribes and re-renders when the owner's fetch lands — this caller just does not ask for them itself.
   *
   * It exists because priming is by PARTITION and a partition can be far larger than what a read selects: a player
   * read names one id, but `/players/{sport}` is the only endpoint, so the read fetches a league. One such read is
   * the cost of the data; fifty of them on a screen is fifty requests for the same league. Who owns a fetch is a
   * property of the call site, not of the read — the same `usePlayer` is a screen's own fetch in one place and a list
   * row under an owner in another — which is why this lives here and not on the declaration.
   *
   * Only `false` is accepted. A call site may decline to prime, but cannot make a read prime that declares it will
   * not, so there is no `true` to mistake for forcing one.
   */
  prime?: false;
}

/**
 * A read as a store publishes it: `undefined` args mean there is nothing to read yet, so it returns `empty`. Its
 * members are properties, so a store's reads are checked contravariantly against them.
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

/** Stable identities so a disabled read's hooks keep the same deps across renders. */
const NO_KEYS: readonly never[] = Object.freeze([]);
const NO_GROUPS: readonly (readonly never[])[] = Object.freeze([]);
const NO_PARTITIONS: readonly (readonly string[])[] = Object.freeze([]);
const NO_ARGS_KEY = `${KEY_SEP}disabled`;

/** Above one viewport's worth of rows: a virtualized list self-limits around 20-30. */
const FANOUT_WARN_THRESHOLD = 48;

/** Entries in a surface's presence cache, which is keyed by partition and so bounds live partitions. */
const PRESENCE_CACHE_MAX = 512;
const fanoutWarned = createOnceGuard();
let fanoutTick: Map<string, { keys: Set<string>; batched: boolean }> | null = null;
onGuardReset(() => {
  fanoutTick = null;
});

function flushFanout(): void {
  const tick = fanoutTick;
  fanoutTick = null;
  if (!shouldLog('warn')) return;
  tick?.forEach((entry, store) => {
    if (entry.keys.size <= FANOUT_WARN_THRESHOLD || fanoutWarned.seen(store)) return;
    const sample = [...entry.keys].slice(0, 3).join(', ');
    // Already-batched callers need the opposite advice from per-row ones: telling a list that reads five ids a row
    // to "use a plural read" describes what it is doing, and it stops reading the warning.
    const remedy = entry.batched
      ? 'These reads are already plural, so the fix is not a plural read but one read higher up: lift it to the ' +
        "parent over the union of what its rows ask for, and let each row index into that result. If the rows' " +
        'sets come from a list the parent already holds, `createWindowedList` resolves them against it.'
      : 'A list is reading per row, which puts one subscription and one hydration on the heap per row. Read the ' +
        "set once in the parent — a plural `*ByIds` read, or `createWindowedList` so rows resolve against the " +
        "parent's list — and let each row index into that.";
    // eslint-disable-next-line no-console
    console.warn(
      `[${store}_store] ${entry.keys.size} separate reads in one tick (e.g. ${sample}). ${remedy} Note that a ` +
        'plural read still primes by PARTITION, not by the ids it asks for, so if this partition is coarse the ' +
        'parent read fetches all of it either way and this is about subscriptions rather than fetching; where the ' +
        'rows are already to hand from the payload that listed them, prefer rendering from those and declaring ' +
        '`prime: false`.',
    );
  });
}

/** `batchSize` is the widest array a read varies by, so a caller already asking for a set can be told something else. */
function noteRead(store: string, argsKey: string, batchSize: number): void {
  if (fanoutWarned.has(store)) return;
  if (!fanoutTick) {
    fanoutTick = new Map();
    setTimeout(flushFanout, 0);
  }
  const entry = getOrCreate(fanoutTick, store, () => ({ keys: new Set<string>(), batched: false }));
  entry.keys.add(argsKey);
  if (batchSize > 1) entry.batched = true;
}

/** The widest set a read is varying by: 1 when it names one thing, which is the per-row shape the warning is for. */
function batchSizeOf(vary: readonly VaryValue[]): number {
  let widest = 1;
  for (const value of vary) if (Array.isArray(value) && value.length > widest) widest = value.length;
  return widest;
}

/** Returns a {@link DataResult} whose identity is stable across renders while its parts hold. */
export function useResult<T>(data: T, status: DataStatus, isFetching: boolean, doRefetch: () => void): DataResult<T> {
  return useMemo(() => makeResult(data, status, { isFetching, refetch: doRefetch }), [data, status, isFetching, doRefetch]);
}

/** What a read's value cache is keyed by beyond its partitions, resolved once per read. */
function varyResolver<Args>(def: { varyBy?: VarySpec<Args> }): (args: Args) => readonly VaryValue[] {
  return def.varyBy ? varyValuesOf(def.varyBy) : () => EMPTY_VARY;
}

/**
 * What a read wants of the partitions it primes. A `varyBy` is the read saying it selects part of one, which is
 * the only shape where an oversized ingest is worth reporting; a read without one is asking for the partition.
 */
function intentOf(def: { varyBy?: unknown }): { slice: boolean } | undefined {
  return def.varyBy ? SELECTS_SLICE : undefined;
}

const SELECTS_SLICE = { slice: true } as const;

/**
 * Whether a read may prime its partitions and whether its `select` may run. Priming asks strictly less: a read
 * still waiting on a vary value primes anyway, so the rows are there when the value arrives.
 */
function readGates<Args>(
  def: { enabled?: (args: Args) => boolean; prime?: boolean },
  args: Args,
  addressable: boolean,
  vary: readonly VaryValue[],
  primeWanted: boolean,
): { prime: boolean; read: boolean } {
  return {
    // Both the declaration and the call site can veto priming, and neither can override the other: a read that
    // declares `prime: false` never fetches, and a caller passing `prime: false` never fetches, whoever else does.
    prime: addressable && primeWanted && (def.prime ?? true),
    read: addressable && vary.every(isVaryPresent) && (def.enabled?.(args) ?? true),
  };
}

/** The status and `DataResult` every read ends with; `hasData` is a thunk, called once the read is known enabled. */
function useReadTail<T>(data: T, enabled: boolean, hasData: () => boolean, prime: PrimeState, doRefetch: () => void): DataResult<T> {
  const status = runSubscribed(() => offHeapStatus(enabled, enabled && hasData(), prime));
  return useResult(data, status, prime.isFetching, doRefetch);
}

/**
 * Builds the read engine over one store's partitions: `read` / `readMany` / `readGrouped` each take a descriptor and
 * hand back its `useValue` / `getValue` pair, with the priming, the version subscription, the presence gate and the
 * value cache already wrapped around `select`. `definePartitions` builds one per store, so stores declare reads.
 */
export function createReadSurface<Key>(kernel: ReadSurfaceKernel<Key>) {
  const { ingest, toParts } = kernel;


  const usePriming = ingest?.usePrime ?? NO_PRIMING;
  const usePrimingAll = ingest?.usePrimeMany ?? NO_PRIMING;

  /** Whether each partition holds rows, keyed by partition and shared by every read on this surface. */
  const presenceByVersion = createVersionedCache<boolean>(PRESENCE_CACHE_MAX);
  // Held against the presence version, which moves only on a write that could have emptied or filled the partition,
  // and tracks presence alone: a read of one unit must not come to depend on the whole partition by asking this.
  const hasOne = (key: Key, parts: readonly string[]): boolean =>
    presenceByVersion.read(cacheKeyOf(parts), kernel.version.getPresence(parts), () => covered(() => kernel.has(key)));
  const hasAny = (entries: readonly PartitionEntry<Key>[]): boolean => entries.some((entry) => addressesPartition(entry.parts) && hasOne(entry.key, entry.parts));

  /**
   * Starts an unfetched partition's fetch. Only `getValue` needs it; a reactive read primes through `usePrime`.
   * Cold means never fetched, not empty: a partition holding rows a socket pushed into it has never had its body,
   * and gating on rows would leave it on that one row for the session.
   */
  const primeIfCold = (key: Key, parts: readonly string[]): void => {
    if (!ingest) return;
    const fetched = kernel.hasFetched ? kernel.hasFetched(key) : hasOne(key, parts);
    if (!fetched) ingest.ensure(key);
  };

  const makeValueCache = <T>(def: { getCacheMax?: number; isEqual?: (left: T, right: T) => boolean }) =>
    createTrackedCache<T>(def.getCacheMax ?? 256, def.isEqual ?? shallowEqualValue);

  /**
   * Runs a read's `select` and makes sure the result depends on enough. A `select` built from projections and unit
   * memos reports the units it read and depends on those alone. One that read rows straight off the table, or reported
   * nothing at all, is made to depend on every partition it named: it could have read anything in them.
   */
  const selectTracked = <T>(partitions: readonly (readonly string[])[], select: () => T): T => {
    const before = uncoveredReads();
    const { value, deps } = runTracked(select);
    for (const dep of deps) trackDependency(dep);
    if (!deps.length || uncoveredReads() !== before) for (const parts of partitions) if (addressesPartition(parts)) kernel.version.get(parts);
    return value;
  };

  function defineRead<Args, T, const V extends VarySpec<Args>>(def: ReadDef<Args, Key, T, V>): Read<Args, T> {
    const getCache = makeValueCache<T>(def);
    const spec = def.partition ?? (kernel.defaultPartition as readonly PartitionField<Args>[] | ((args: Args) => Key) | undefined);
    if (!spec)
      throw new Error(`${kernel.name ?? 'off_heap'}_store: this read needs a \`partition\`, since the store's key declares no \`fields\` to default to`);
    const keyOf = partitionKeyOf<Args, Key>(spec);
    const varyOf = varyResolver<Args>(def);
    const primeIntent = intentOf(def);
    const select = overArgs<Args, Key, T, V>(def.select);
    const gatesFor = (args: Args, parts: readonly string[], vary: readonly VaryValue[], wanted: boolean, primeWanted = true) =>
      readGates(def, args, wanted && addressesPartition(parts), vary, primeWanted);

    const cached = (args: Args, key: Key, parts: readonly string[], argsKey: string): T =>
      getCache.read(argsKey, () => selectTracked([parts], () => select(args, key)));

    function getValue(args: Args | undefined): T {
      if (args === undefined) return def.empty;
      const key = keyOf(args);
      const parts = toParts(key);
      if (!addressesPartition(parts)) return def.empty;
      const vary = varyOf(args);
      const gates = gatesFor(args, parts, vary, true);
      if (gates.prime) primeIfCold(key, parts);
      // Every path reports something to the scope above it, so a derivation that got `empty` here still hears when
      // the partition lands: presence for a disabled or cold read, and whatever `select` read otherwise.
      if (!gates.read) {
        kernel.version.getPresence(parts);
        return def.empty;
      }
      if (!hasOne(key, parts)) return def.empty;
      return cached(args, key, parts, varyKey(parts, vary));
    }

    function useValue(args: Args | undefined, options?: ReadCallOptions): DataResult<T> {
      // `partition`, `varyBy` and `select` assume a real partition; the hooks below still run, reading nothing.
      const key = args === undefined ? undefined : keyOf(args);
      const parts = key === undefined ? NO_PARTS : toParts(key);
      const vary = args === undefined ? EMPTY_VARY : varyOf(args);
      const gates = gatesFor(args as Args, parts, vary, (options?.enabled ?? true) && args !== undefined, options?.prime ?? true);
      const prime = usePriming(key, gates.prime, primeIntent);
      const argsKey = args === undefined ? NO_ARGS_KEY : varyKey(parts, vary);
      if (__DEV__ && gates.read) noteRead(kernel.name ?? 'off_heap', argsKey, batchSizeOf(vary));
      const data = useTrackedValue<T>(() => (hasOne(key as Key, parts) ? cached(args as Args, key as Key, parts, argsKey) : def.empty), [argsKey], {
        enabled: gates.read,
        isEqual: def.isEqual ?? shallowEqualValue,
        empty: def.empty,
      });
      const doRefetch = useCallback(() => {
        if (key !== undefined) ingest?.refetch(key);
      }, [argsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `argsKey` covers `key`
      return useReadTail(data, gates.read, () => addressesPartition(parts) && hasOne(key as Key, parts), prime, doRefetch);
    }

    return { getValue, useValue, requires: def.requires ?? requiredFieldsOf<Args, Key>(spec, def.varyBy) };
  }

  /**
   * The engine behind `readMany` and `readGrouped`, which differ only in what `select` is handed back: the flat
   * keys, or the groups they were named in. `resolve` runs once per call because naming a partition may intern it.
   */
  function manyRead<Args, T, Named>(
    def: CommonDef<Args, T, VarySpec<Args>>,
    resolve: (args: Args) => { keys: readonly Key[]; named: Named },
    select: (args: Args, named: Named) => T,
    noneNamed: Named,
  ): Read<Args, T> {
    const getCache = makeValueCache<T>(def);
    const varyOf = varyResolver<Args>(def);
    const primeIntent = intentOf(def);
    const cacheKeyOf = (partitions: readonly (readonly string[])[], vary: readonly VaryValue[]): string => varyKey([partitionsKey(partitions)], vary);
    const resolveOr = (args: Args | undefined) => (args === undefined ? { keys: NO_KEYS as readonly Key[], named: noneNamed } : resolve(args));

    /** `read`'s gates over a set: addressable when at least one partition is, since the rest are gaps. */
    const gatesFor = (args: Args, partitions: readonly (readonly string[])[], vary: readonly VaryValue[], wanted: boolean, primeWanted = true) =>
      readGates(def, args, wanted && partitions.some(addressesPartition), vary, primeWanted);

    const cached = (args: Args, named: Named, partitions: readonly (readonly string[])[], argsKey: string): T =>
      getCache.read(argsKey, () => selectTracked(partitions, () => select(args, named)));

    /** Presence of every partition named, which is what a read reports when it has nothing else to depend on. */
    const trackPresence = (partitions: readonly (readonly string[])[]): void => {
      for (const parts of partitions) if (addressesPartition(parts)) kernel.version.getPresence(parts);
    };

    function getValue(args: Args | undefined): T {
      if (args === undefined) return def.empty;
      const { keys, named } = resolve(args);
      const entries = partitionEntries(keys, toParts);
      const partitions = entries.map((entry) => entry.parts);
      const vary = varyOf(args);
      const gates = gatesFor(args, partitions, vary, true);
      if (gates.prime) for (const entry of entries) if (addressesPartition(entry.parts)) primeIfCold(entry.key, entry.parts);
      // `hasAny` stops at the first partition holding rows, so the rest are reported here for a read that lands later.
      trackPresence(partitions);
      if (!gates.read || !hasAny(entries)) return def.empty;
      return cached(args, named, partitions, cacheKeyOf(partitions, vary));
    }

    function useValue(args: Args | undefined, options?: ReadCallOptions): DataResult<T> {
      const { keys, named } = resolveOr(args);
      const entries = args === undefined ? [] : partitionEntries(keys, toParts);
      const partitions = args === undefined ? NO_PARTITIONS : entries.map((entry) => entry.parts);
      const vary = args === undefined ? EMPTY_VARY : varyOf(args);
      const gates = gatesFor(args as Args, partitions, vary, (options?.enabled ?? true) && args !== undefined, options?.prime ?? true);
      const prime = usePrimingAll(keys, gates.prime, primeIntent);
      const argsKey = args === undefined ? NO_ARGS_KEY : cacheKeyOf(partitions, vary);
      const data = useTrackedValue<T>(
        () => {
          trackPresence(partitions);
          return hasAny(entries) ? cached(args as Args, named, partitions, argsKey) : def.empty;
        },
        [argsKey],
        { enabled: gates.read, isEqual: def.isEqual ?? shallowEqualValue, empty: def.empty },
      );
      const doRefetch = useCallback(() => {
        for (const key of keys) ingest?.refetch(key);
      }, [argsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `argsKey` covers `keys`
      return useReadTail(data, gates.read, () => hasAny(entries), prime, doRefetch);
    }

    return { getValue, useValue, requires: def.requires };
  }

  function defineReadMany<Args, T, const V extends VarySpec<Args>>(def: ReadManyDef<Args, Key, T, V>): Read<Args, T> {
    const resolve = (args: Args) => {
      const keys = def.partitions(args);
      return { keys, named: keys };
    };
    return manyRead<Args, T, readonly Key[]>(def, resolve, overArgs<Args, readonly Key[], T, V>(def.select), NO_KEYS);
  }

  function defineReadGrouped<Args, T, const V extends VarySpec<Args>>(def: ReadGroupedDef<Args, Key, T, V>): Read<Args, T> {
    const resolve = (args: Args) => {
      const named = def.groups(args);
      const keys: Key[] = [];
      for (const group of named) for (const key of group) keys.push(key);
      return { keys, named };
    };
    return manyRead<Args, T, readonly (readonly Key[])[]>(def, resolve, overArgs<Args, readonly (readonly Key[])[], T, V>(def.select), NO_GROUPS);
  }

  /** The surface's cached presence probe, so a store asks the same question the reads gate on. */
  const has = (key: Key): boolean => hasOne(key, toParts(key));

  return {
    /**
     * Declares a read, in two calls: `read<Args, Value>()({ … })`. The first names what the read takes and returns, the
     * second takes the read itself — separately, because that is what leaves TypeScript free to infer `varyBy` from the
     * list a read spells, which is how `select` comes to see those fields and no others.
     */
    read: <Args, T>() => defineRead as <const V extends VarySpec<Args> = readonly []>(def: ReadDef<Args, Key, T, V>) => Read<Args, T>,
    readMany: <Args, T>() => defineReadMany as <const V extends VarySpec<Args> = readonly []>(def: ReadManyDef<Args, Key, T, V>) => Read<Args, T>,
    readGrouped: <Args, T>() => defineReadGrouped as <const V extends VarySpec<Args> = readonly []>(def: ReadGroupedDef<Args, Key, T, V>) => Read<Args, T>,
    has,
  };
}
