"use strict";

/**
 * Reads: how a store turns a read definition into a hook (`useValue`) and a getter (`getValue`).
 *
 * A read names a partition with its args (a partition is the set of rows one fetch returns and replaces), fetches the
 * partition if it has never been fetched, and runs the read's `select` over the partition's rows to compute its
 * value. The value is cached by partition and args, shared by every caller with the same ones, and recomputed only
 * when rows it depended on change; the hook re-renders its component only when the recomputed value differs.
 */

import { useCallback, useMemo } from 'react';
import { EMPTY_VARY, isVaryPresent, KEY_SEP, partitionsKey, varyKey, cacheKeyOf } from "../args_key.js";
import { getOrCreate } from "../collections.js";
import { partitionKeyOf, requiredFieldsOf, varyValuesOf } from "./partition_fields.js";
import { createTrackedCache, createVersionedCache, shallowEqualValue } from "../caches.js";
import { addressesPartition, NO_PARTS, partitionEntries } from "../reactivity/version_atom.js";
import { createOnceGuard, onGuardReset } from "../diagnostics/once_guard.js";
import { shouldLog } from "../diagnostics/log_level.js";
import { NO_PRIMING } from "../prime_state.js";
import { makeResult, offHeapStatus } from "../store_result.js";
import { runSubscribed, runTracked, trackDependency } from "../reactivity/tracking.js";
import { useTrackedValue } from "../reactivity/tracked_value.js";
import { covered, uncoveredReads } from "../table/read_coverage.js";

/**
 * The parts of a store's fetch ingest that its reads use: the hooks that fetch partitions, and imperative fetch starts.
 */

/**
 * What a store's reads need from the store: its version atom, how a partition key becomes its version key, whether a
 * partition has rows or has been fetched, and the fetch ingest. `definePartitions` builds this for each store.
 */

/**
 * A read's `varyBy`: the args, beyond the partition, that its value depends on. Either a list of args field names,
 * such as `['playerId']`, or a function that computes the values from the args.
 */

/**
 * The args a read's `select` receives: only the fields its `varyBy` lists, each typed as non-null, since `select` only
 * runs once all of them have values. Reading any other arg in `select` is a type error, because the read's cached value
 * is shared by every caller whose partition and `varyBy` values match; a value computed from an unlisted arg would be
 * served to callers that passed a different one. A read whose `varyBy` is a function lists no fields, so its `select`
 * receives the whole args.
 */

/**
 * Hands `select` the whole args object, which carries the fields it declared and others it cannot see. Sound because
 * the narrowing exists to stop a store *writing* a reach into an undeclared arg, not to hide anything at runtime.
 */
function overArgs(select) {
  return select;
}

/** The fields every kind of read definition shares (`read`, `readMany` and `readGrouped`). */

/**
 * The definition of a read of one partition. The args name one partition (through `partition`, or the store's key
 * fields by default); the read fetches it if it has never been fetched, and `select` computes the value from its rows.
 * Nearly every read is this kind. For a read across several partitions, use `ReadManyDef`; for several lookups at once,
 * each with its own candidate partitions, use `ReadGroupedDef`.
 */

/**
 * The definition of a read across several partitions, fetched and subscribed to together and computed into one value,
 * such as one player's stat rows across several weeks, one partition per week. `select` gets the partition keys as one
 * flat list. For several lookups at once, each with its own candidate partitions, use `ReadGroupedDef`.
 */

/**
 * The definition of a read that answers several lookups at once, where each lookup's rows could be in any of several
 * candidate partitions, such as a stat row for each of several stat keys, where each key could be in more than one
 * partition. `groups` gives each lookup's candidate partitions; all of them are fetched and subscribed to; `select`
 * gets the groups back in the same order, so it can answer each lookup from its own candidates.
 */

/**
 * Options one caller passes to a read's `useValue` hook, on top of what the read's definition fixes. They apply to
 * that call only.
 */

/**
 * A declared read, as a store's `reads` hold it: a hook (`useValue`) and a getter (`getValue`) that return the same
 * value. Both take the read's args, or `undefined` when the caller doesn't have them yet, which returns `empty`.
 */

/** Stable identities so a disabled read's hooks keep the same deps across renders. */
const NO_KEYS = Object.freeze([]);
const NO_GROUPS = Object.freeze([]);
const NO_PARTITIONS = Object.freeze([]);
const NO_ARGS_KEY = `${KEY_SEP}disabled`;

/** Above one viewport's worth of rows: a virtualized list self-limits around 20-30. */
const FANOUT_WARN_THRESHOLD = 48;

/** Entries in a surface's presence cache, which is keyed by partition and so bounds live partitions. */
const PRESENCE_CACHE_MAX = 512;
const fanoutWarned = createOnceGuard();
let fanoutTick = null;
onGuardReset(() => {
  fanoutTick = null;
});
function flushFanout() {
  const tick = fanoutTick;
  fanoutTick = null;
  if (!shouldLog('warn')) return;
  tick?.forEach((entry, store) => {
    if (entry.keys.size <= FANOUT_WARN_THRESHOLD || fanoutWarned.seen(store)) return;
    const sample = [...entry.keys].slice(0, 3).join(', ');
    // Already-batched callers need the opposite advice from per-row ones: telling a list that reads five ids a row
    // to "use a plural read" describes what it is doing, and it stops reading the warning.
    const remedy = entry.batched ? 'These reads are already plural, so the fix is not a plural read but one read higher up: lift it to the ' + "parent over the union of what its rows ask for, and let each row index into that result. If the rows' " + 'sets come from a list the parent already holds, `createWindowedList` resolves them against it.' : 'A list is reading per row, which puts one subscription and one hydration on the heap per row. Read the ' + "set once in the parent — a plural `*ByIds` read, or `createWindowedList` so rows resolve against the " + "parent's list — and let each row index into that.";
    // eslint-disable-next-line no-console
    console.warn(`[${store}_store] ${entry.keys.size} separate reads in one tick (e.g. ${sample}). ${remedy} Note that a ` + 'plural read still primes by PARTITION, not by the ids it asks for, so if this partition is coarse the ' + 'parent read fetches all of it either way and this is about subscriptions rather than fetching; where the ' + 'rows are already to hand from the payload that listed them, prefer rendering from those and declaring ' + '`prime: false`.');
  });
}

/**
 * `batchSize` is the widest array a read varies by, so a caller already asking for a set can be told something else.
 */
function noteRead(store, argsKey, batchSize) {
  if (fanoutWarned.has(store)) return;
  if (!fanoutTick) {
    fanoutTick = new Map();
    setTimeout(flushFanout, 0);
  }
  const entry = getOrCreate(fanoutTick, store, () => ({
    keys: new Set(),
    batched: false
  }));
  entry.keys.add(argsKey);
  if (batchSize > 1) entry.batched = true;
}

/** The widest set a read is varying by: 1 when it names one thing, which is the per-row shape the warning is for. */
function batchSizeOf(vary) {
  let widest = 1;
  for (const value of vary) if (Array.isArray(value) && value.length > widest) widest = value.length;
  return widest;
}

/** Returns a {@link DataResult} whose identity is stable across renders while its parts hold. */
export function useResult(data, status, isFetching, doRefetch) {
  return useMemo(() => makeResult(data, status, {
    isFetching,
    refetch: doRefetch
  }), [data, status, isFetching, doRefetch]);
}

/** What a read's value cache is keyed by beyond its partitions, resolved once per read. */
function varyResolver(def) {
  return def.varyBy ? varyValuesOf(def.varyBy) : () => EMPTY_VARY;
}

/**
 * What a read wants of the partitions it primes. A `varyBy` is the read saying it selects part of one, which is
 * the only shape where an oversized ingest is worth reporting; a read without one is asking for the partition.
 */
function intentOf(def) {
  return def.varyBy ? SELECTS_SLICE : undefined;
}
const SELECTS_SLICE = {
  slice: true
};

/**
 * Whether a read may prime its partitions and whether its `select` may run. Priming asks strictly less: a read
 * still waiting on a vary value primes anyway, so the rows are there when the value arrives.
 */
function readGates(def, args, addressable, vary, primeWanted) {
  return {
    // Both the declaration and the call site can veto priming, and neither can override the other: a read that
    // declares `prime: false` never fetches, and a caller passing `prime: false` never fetches, whoever else does.
    prime: addressable && primeWanted && (def.prime ?? true),
    read: addressable && vary.every(isVaryPresent) && (def.enabled?.(args) ?? true)
  };
}

/** The status and `DataResult` every read ends with; `hasData` is a thunk, called once the read is known enabled. */
function useReadTail(data, enabled, hasData, prime, doRefetch) {
  const status = runSubscribed(() => offHeapStatus(enabled, enabled && hasData(), prime));
  return useResult(data, status, prime.isFetching, doRefetch);
}

/**
 * Builds the read engine over one store's partitions: `read` / `readMany` / `readGrouped` each take a descriptor and
 * hand back its `useValue` / `getValue` pair, with the priming, the version subscription, the presence gate and the
 * value cache already wrapped around `select`. `definePartitions` builds one per store, so stores declare reads.
 */
export function createReadSurface(kernel) {
  const {
    ingest,
    toParts
  } = kernel;
  const usePriming = ingest?.usePrime ?? NO_PRIMING;
  const usePrimingAll = ingest?.usePrimeMany ?? NO_PRIMING;

  /** Whether each partition holds rows, keyed by partition and shared by every read on this surface. */
  const presenceByVersion = createVersionedCache(PRESENCE_CACHE_MAX);
  // Held against the presence version, which moves only on a write that could have emptied or filled the partition,
  // and tracks presence alone: a read of one unit must not come to depend on the whole partition by asking this.
  const hasOne = (key, parts) => presenceByVersion.read(cacheKeyOf(parts), kernel.version.getPresence(parts), () => covered(() => kernel.has(key)));
  const hasAny = entries => entries.some(entry => addressesPartition(entry.parts) && hasOne(entry.key, entry.parts));

  /**
   * Starts an unfetched partition's fetch. Only `getValue` needs it; a reactive read primes through `usePrime`.
   * Cold means never fetched, not empty: a partition holding rows a socket pushed into it has never had its body,
   * and gating on rows would leave it on that one row for the session.
   */
  const primeIfCold = (key, parts) => {
    if (!ingest) return;
    const fetched = kernel.hasFetched ? kernel.hasFetched(key) : hasOne(key, parts);
    if (!fetched) ingest.ensure(key);
  };
  const makeValueCache = def => createTrackedCache(def.getCacheMax ?? 256, def.isEqual ?? shallowEqualValue);

  /**
   * Runs a read's `select` and makes sure the result depends on enough. A `select` built from projections and unit
   * memos reports the units it read and depends on those alone. One that read rows straight off the table, or reported
   * nothing at all, is made to depend on every partition it named: it could have read anything in them.
   */
  const selectTracked = (partitions, select) => {
    const before = uncoveredReads();
    const {
      value,
      deps
    } = runTracked(select);
    for (const dep of deps) trackDependency(dep);
    if (!deps.length || uncoveredReads() !== before) for (const parts of partitions) if (addressesPartition(parts)) kernel.version.get(parts);
    return value;
  };
  function defineRead(def) {
    const getCache = makeValueCache(def);
    const spec = def.partition ?? kernel.defaultPartition;
    if (!spec) throw new Error(`${kernel.name ?? 'off_heap'}_store: this read needs a \`partition\`, since the store's key declares no \`fields\` to default to`);
    const keyOf = partitionKeyOf(spec);
    const varyOf = varyResolver(def);
    const primeIntent = intentOf(def);
    const select = overArgs(def.select);
    const gatesFor = (args, parts, vary, wanted, primeWanted = true) => readGates(def, args, wanted && addressesPartition(parts), vary, primeWanted);
    const cached = (args, key, parts, argsKey) => getCache.read(argsKey, () => selectTracked([parts], () => select(args, key)));
    function getValue(args) {
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
    function useValue(args, options) {
      // `partition`, `varyBy` and `select` assume a real partition; the hooks below still run, reading nothing.
      const key = args === undefined ? undefined : keyOf(args);
      const parts = key === undefined ? NO_PARTS : toParts(key);
      const vary = args === undefined ? EMPTY_VARY : varyOf(args);
      const gates = gatesFor(args, parts, vary, (options?.enabled ?? true) && args !== undefined, options?.prime ?? true);
      const prime = usePriming(key, gates.prime, primeIntent);
      const argsKey = args === undefined ? NO_ARGS_KEY : varyKey(parts, vary);
      if (__DEV__ && gates.read) noteRead(kernel.name ?? 'off_heap', argsKey, batchSizeOf(vary));
      const data = useTrackedValue(() => hasOne(key, parts) ? cached(args, key, parts, argsKey) : def.empty, [argsKey], {
        enabled: gates.read,
        isEqual: def.isEqual ?? shallowEqualValue,
        empty: def.empty
      });
      const doRefetch = useCallback(() => {
        if (key !== undefined) ingest?.refetch(key);
      }, [argsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `argsKey` covers `key`
      return useReadTail(data, gates.read, () => addressesPartition(parts) && hasOne(key, parts), prime, doRefetch);
    }
    return {
      getValue,
      useValue,
      requires: def.requires ?? requiredFieldsOf(spec, def.varyBy)
    };
  }

  /**
   * The engine behind `readMany` and `readGrouped`, which differ only in what `select` is handed back: the flat
   * keys, or the groups they were named in. `resolve` runs once per call because naming a partition may intern it.
   */
  function manyRead(def, resolve, select, noneNamed) {
    const getCache = makeValueCache(def);
    const varyOf = varyResolver(def);
    const primeIntent = intentOf(def);
    const cacheKeyOf = (partitions, vary) => varyKey([partitionsKey(partitions)], vary);
    const resolveOr = args => args === undefined ? {
      keys: NO_KEYS,
      named: noneNamed
    } : resolve(args);

    /** `read`'s gates over a set: addressable when at least one partition is, since the rest are gaps. */
    const gatesFor = (args, partitions, vary, wanted, primeWanted = true) => readGates(def, args, wanted && partitions.some(addressesPartition), vary, primeWanted);
    const cached = (args, named, partitions, argsKey) => getCache.read(argsKey, () => selectTracked(partitions, () => select(args, named)));

    /** Presence of every partition named, which is what a read reports when it has nothing else to depend on. */
    const trackPresence = partitions => {
      for (const parts of partitions) if (addressesPartition(parts)) kernel.version.getPresence(parts);
    };
    function getValue(args) {
      if (args === undefined) return def.empty;
      const {
        keys,
        named
      } = resolve(args);
      const entries = partitionEntries(keys, toParts);
      const partitions = entries.map(entry => entry.parts);
      const vary = varyOf(args);
      const gates = gatesFor(args, partitions, vary, true);
      if (gates.prime) for (const entry of entries) if (addressesPartition(entry.parts)) primeIfCold(entry.key, entry.parts);
      // `hasAny` stops at the first partition holding rows, so the rest are reported here for a read that lands later.
      trackPresence(partitions);
      if (!gates.read || !hasAny(entries)) return def.empty;
      return cached(args, named, partitions, cacheKeyOf(partitions, vary));
    }
    function useValue(args, options) {
      const {
        keys,
        named
      } = resolveOr(args);
      const entries = args === undefined ? [] : partitionEntries(keys, toParts);
      const partitions = args === undefined ? NO_PARTITIONS : entries.map(entry => entry.parts);
      const vary = args === undefined ? EMPTY_VARY : varyOf(args);
      const gates = gatesFor(args, partitions, vary, (options?.enabled ?? true) && args !== undefined, options?.prime ?? true);
      const prime = usePrimingAll(keys, gates.prime, primeIntent);
      const argsKey = args === undefined ? NO_ARGS_KEY : cacheKeyOf(partitions, vary);
      const data = useTrackedValue(() => {
        trackPresence(partitions);
        return hasAny(entries) ? cached(args, named, partitions, argsKey) : def.empty;
      }, [argsKey], {
        enabled: gates.read,
        isEqual: def.isEqual ?? shallowEqualValue,
        empty: def.empty
      });
      const doRefetch = useCallback(() => {
        for (const key of keys) ingest?.refetch(key);
      }, [argsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `argsKey` covers `keys`
      return useReadTail(data, gates.read, () => hasAny(entries), prime, doRefetch);
    }
    return {
      getValue,
      useValue,
      requires: def.requires
    };
  }
  function defineReadMany(def) {
    const resolve = args => {
      const keys = def.partitions(args);
      return {
        keys,
        named: keys
      };
    };
    return manyRead(def, resolve, overArgs(def.select), NO_KEYS);
  }
  function defineReadGrouped(def) {
    const resolve = args => {
      const named = def.groups(args);
      const keys = [];
      for (const group of named) for (const key of group) keys.push(key);
      return {
        keys,
        named
      };
    };
    return manyRead(def, resolve, overArgs(def.select), NO_GROUPS);
  }

  /** The surface's cached presence probe, so a store asks the same question the reads gate on. */
  const has = key => hasOne(key, toParts(key));
  return {
    /**
     * Declares a read, in two calls: `read<Args, Value>()({ … })`. The first names what the read takes and returns, the
     * second takes the read itself — separately, because that is what leaves TypeScript free to infer `varyBy` from the
     * list a read spells, which is how `select` comes to see those fields and no others.
     */
    read: () => defineRead,
    readMany: () => defineReadMany,
    readGrouped: () => defineReadGrouped,
    has
  };
}
//# sourceMappingURL=surface.js.map