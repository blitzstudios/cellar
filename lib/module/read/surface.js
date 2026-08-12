"use strict";

/**
 * Turns one read declaration into a store's `useValue` (reactive) and `getValue` (imperative) pair.
 * `read` is scoped to one partition; `readMany` spans a variable set of them.
 */

import { useCallback, useMemo } from 'react';
import { cacheKey, EMPTY_VARY, isVaryPresent, KEY_SEP, partitionsKey, varyKey } from "../args_key.js";
import { getOrCreate } from "../collections.js";
import { partitionKeyOf, requiredFieldsOf, varyValuesOf } from "./partition_fields.js";
import { createVersionedCache, shallowEqualValue } from "../caches.js";
import { isLive, NO_PARTS, partitionEntries } from "../reactivity/version_atom.js";
import { createOnceGuard, onGuardReset } from "../diagnostics/once_guard.js";
import { NO_PRIMING } from "../prime_state.js";
import { makeResult, offHeapStatus } from "../store_result.js";
import { runSubscribed } from "../reactivity/tracking.js";

/** The fetch half of a store as a read sees it, which `createFetchIngest`'s return value satisfies. */

/**
 * What a read surface needs from its store: the version atom, a key's parts, a presence probe, and the fetch that
 * backs priming. `definePartitions` derives all of it from where a partition's rows live.
 */

/** A read's `varyBy`, either way it can be spelled: the args fields it names, or a value it computes from them. */

/**
 * What a read's `select` is handed, which is the fields it named in `varyBy` and nothing else: reaching an arg the read
 * never declared is what would serve one caller's value to another, so it does not typecheck. Each field is
 * non-nullable, since the read does not run until every one has arrived. A `varyBy` computed by a function names no
 * fields to narrow to, so a read spelling it that way is handed the whole args and answers for them itself.
 */

/**
 * Hands `select` the whole args object, which carries the fields it declared and others it cannot see. Sound because
 * the narrowing exists to stop a store *writing* a reach into an undeclared arg, not to hide anything at runtime.
 */
function overArgs(select) {
  return select;
}

/**
 * Declares a read of one partition, which is the shape nearly every read in a store has: a call's args name a single
 * address, and `select` works within it. Reach past it only when one call has to span several partitions at once:
 * `ReadManyDef` for a set of them, `ReadGroupedDef` when that set arrives as one group per thing the caller asks about.
 */

/**
 * Declares a read whose args resolve to a set of partitions rather than one, primed and subscribed together and read
 * as a single value — a list gathered across addresses, or several candidates for one answer. `select` is handed the
 * keys flat, so use `ReadGroupedDef` instead when the caller asks about several things, each with its own candidates.
 */

/**
 * Declares one read over several things at once, each carrying its own candidate partitions — the plural of a
 * `ReadManyDef` whose keys are candidates for one answer. `select` gets the groups back in the order it named them,
 * so the read answers per thing rather than flattening every candidate into one set and re-slicing it by index.
 */

/**
 * What one call site says about a read, as against what its declaration fixes: `enabled` switches this caller's read
 * and its priming off while its hooks stay mounted, for a screen holding args it should not be reading on yet.
 */

/**
 * A read as a store publishes it: `undefined` args mean there is nothing to read yet, so it returns `empty`. Its
 * members are properties, so a backend's reads are checked contravariantly against them.
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
  tick?.forEach((keys, store) => {
    if (keys.size <= FANOUT_WARN_THRESHOLD || fanoutWarned.seen(store)) return;
    const sample = [...keys].slice(0, 3).join(', ');
    // eslint-disable-next-line no-console
    console.warn(`[${store}_store] ${keys.size} separate reads in one tick (e.g. ${sample}). A list is reading per row, ` + 'which puts one subscription and one hydration on the heap per row. Read the set once in the parent — a ' + "plural `*ByIds` read, or `createWindowedList` so rows resolve against the parent's list — and let each " + 'row index into that.');
  });
}
function noteRead(store, argsKey) {
  if (fanoutWarned.has(store)) return;
  if (!fanoutTick) {
    fanoutTick = new Map();
    setTimeout(flushFanout, 0);
  }
  getOrCreate(fanoutTick, store, () => new Set()).add(argsKey);
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
 * Whether a read may prime its partitions and whether its `select` may run. Priming asks strictly less: a read
 * still waiting on a vary value primes anyway, so the rows are there when the value arrives.
 */
function readGates(def, args, addressable, vary) {
  return {
    prime: addressable && (def.prime ?? true),
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
  const versionOf = partitions => {
    let sum = 0;
    for (const parts of partitions) if (isLive(parts)) sum += kernel.version.get(parts);
    return sum;
  };
  const usePriming = ingest?.usePrime ?? NO_PRIMING;
  const usePrimingAll = ingest?.usePrimeMany ?? NO_PRIMING;

  /** Whether each partition holds rows, keyed by partition and shared by every read on this surface. */
  const presenceByVersion = createVersionedCache(PRESENCE_CACHE_MAX);
  // Memoizable per version because presence only flips on a write, and every write bumps.
  const hasOne = (key, parts) => presenceByVersion.read(cacheKey(...parts), kernel.version.get(parts), () => kernel.has(key));
  const hasAny = entries => entries.some(entry => isLive(entry.parts) && hasOne(entry.key, entry.parts));

  /** Starts a cold partition's fetch. Only `getValue` needs it; a reactive read primes through `usePrime`. */
  const primeIfCold = (key, parts) => {
    if (ingest && !hasOne(key, parts)) ingest.ensure(key);
  };
  const makeValueCache = def => createVersionedCache(def.getCacheMax ?? 256, def.isEqual ?? shallowEqualValue);
  function defineRead(def) {
    const getCache = makeValueCache(def);
    const spec = def.partition ?? kernel.defaultPartition;
    if (!spec) throw new Error(`${kernel.name ?? 'off_heap'}_store: this read needs a \`partition\`, since the store's key declares no \`fields\` to default to`);
    const keyOf = partitionKeyOf(spec);
    const varyOf = varyResolver(def);
    const select = overArgs(def.select);
    const gatesFor = (args, parts, vary, wanted) => readGates(def, args, wanted && isLive(parts), vary);
    const cached = (args, key, parts, argsKey) => getCache.read(argsKey, kernel.version.get(parts), () => select(args, key));
    function getValue(args) {
      if (args === undefined) return def.empty;
      const key = keyOf(args);
      const parts = toParts(key);
      if (!isLive(parts)) return def.empty;
      // Must run on every call, cache hits included, or the enclosing tracking scope misses this dependency.
      kernel.version.get(parts);
      const vary = varyOf(args);
      const gates = gatesFor(args, parts, vary, true);
      if (gates.prime) primeIfCold(key, parts);
      if (!gates.read || !hasOne(key, parts)) return def.empty;
      return cached(args, key, parts, varyKey(parts, vary));
    }
    function useValue(args, options) {
      // `partition`, `varyBy` and `select` assume a real partition; the hooks below still run, reading nothing.
      const key = args === undefined ? undefined : keyOf(args);
      const parts = key === undefined ? NO_PARTS : toParts(key);
      const vary = args === undefined ? EMPTY_VARY : varyOf(args);
      const gates = gatesFor(args, parts, vary, (options?.enabled ?? true) && args !== undefined);
      const prime = usePriming(key, gates.prime);
      const argsKey = args === undefined ? NO_ARGS_KEY : varyKey(parts, vary);
      if (__DEV__ && gates.read) noteRead(kernel.name ?? 'off_heap', argsKey);
      const data = kernel.version.useSelect(parts, gates.read, [argsKey], () => hasOne(key, parts) ? cached(args, key, parts, argsKey) : def.empty, def.isEqual ?? shallowEqualValue, def.empty);
      const doRefetch = useCallback(() => {
        if (key !== undefined) ingest?.refetch(key);
      }, [argsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `argsKey` covers `key`
      return useReadTail(data, gates.read, () => isLive(parts) && hasOne(key, parts), prime, doRefetch);
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
    const cacheKeyOf = (partitions, vary) => varyKey([partitionsKey(partitions)], vary);
    const resolveOr = args => args === undefined ? {
      keys: NO_KEYS,
      named: noneNamed
    } : resolve(args);

    /** `read`'s gates over a set: addressable when at least one partition is, since the rest are gaps. */
    const gatesFor = (args, partitions, vary, wanted) => readGates(def, args, wanted && partitions.some(isLive), vary);
    const cached = (args, named, partitions, argsKey) => getCache.read(argsKey, versionOf(partitions), () => select(args, named));
    function getValue(args) {
      if (args === undefined) return def.empty;
      const {
        keys,
        named
      } = resolve(args);
      const entries = partitionEntries(keys, toParts);
      const partitions = entries.map(entry => entry.parts);
      // Tracking, on every call — see `read.getValue`.
      versionOf(partitions);
      const vary = varyOf(args);
      const gates = gatesFor(args, partitions, vary, true);
      if (gates.prime) for (const entry of entries) if (isLive(entry.parts)) primeIfCold(entry.key, entry.parts);
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
      const gates = gatesFor(args, partitions, vary, (options?.enabled ?? true) && args !== undefined);
      const prime = usePrimingAll(keys, gates.prime);
      const argsKey = args === undefined ? NO_ARGS_KEY : cacheKeyOf(partitions, vary);
      const data = kernel.version.useSelectMany(partitions, gates.read, [argsKey], () => hasAny(entries) ? cached(args, named, partitions, argsKey) : def.empty, def.isEqual ?? shallowEqualValue, def.empty);
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