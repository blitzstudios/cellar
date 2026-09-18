"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createReadSurface = createReadSurface;
exports.useResult = useResult;
var _react = require("react");
var _args_key = require("../args_key.js");
var _collections = require("../collections.js");
var _partition_fields = require("./partition_fields.js");
var _caches = require("../caches.js");
var _version_atom = require("../reactivity/version_atom.js");
var _once_guard = require("../diagnostics/once_guard.js");
var _prime_state = require("../prime_state.js");
var _store_result = require("../store_result.js");
var _tracking = require("../reactivity/tracking.js");
/**
 * Turns one read declaration into a store's `useValue` (reactive) and `getValue` (imperative) pair.
 * `read` is scoped to one partition; `readMany` spans a variable set of them.
 */

/** The fetch half of a store as a read sees it, which `createFetchIngest`'s return value satisfies. */

/**
 * What a read surface needs from its store: the version atom, a key's parts, a presence probe, and the fetch that
 * backs priming. `definePartitions` derives all of it from where a partition's rows live.
 */

/** A read's `varyBy`, either way it can be spelled: the args fields it names, or a value it computes from them. */

/**
 * What a read does about a partition holding no rows yet. Spelled as a word rather than `true` because the two
 * settings are not the same size of act: `'partition'` fetches the *whole* partition however little of it this read
 * goes on to select, which is the whole cost of a cold read and the thing a call site cannot see.
 */

/**
 * Makes `prime` a required answer for a read that declares a `varyBy`, and leaves it optional otherwise.
 *
 * A `varyBy` is the read saying it wants a *slice* of its partition. That is exactly the shape where priming is a
 * gamble the declaration cannot settle on its own — a partition is as large as the store made it, and a read of
 * twenty ids out of a league's whole roster fetches the roster. A read with no `varyBy` wants the partition entire,
 * so priming it is plainly right and nothing is asked. This is a type-level question, not a rule: either answer is
 * fine, but a narrowing read has to have been asked it.
 */

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
const NO_ARGS_KEY = `${_args_key.KEY_SEP}disabled`;

/** Above one viewport's worth of rows: a virtualized list self-limits around 20-30. */
const FANOUT_WARN_THRESHOLD = 48;

/** Entries in a surface's presence cache, which is keyed by partition and so bounds live partitions. */
const PRESENCE_CACHE_MAX = 512;
const fanoutWarned = (0, _once_guard.createOnceGuard)();
let fanoutTick = null;
(0, _once_guard.onGuardReset)(() => {
  fanoutTick = null;
});
function flushFanout() {
  const tick = fanoutTick;
  fanoutTick = null;
  tick?.forEach((keys, store) => {
    if (keys.size <= FANOUT_WARN_THRESHOLD || fanoutWarned.seen(store)) return;
    const sample = [...keys].slice(0, 3).join(', ');
    // eslint-disable-next-line no-console
    console.warn(`[${store}_store] ${keys.size} separate reads in one tick (e.g. ${sample}). A list is reading per row, ` + 'which puts one subscription and one hydration on the heap per row. Read the set once in the parent — a ' + "plural `*ByIds` read, or `createWindowedList` so rows resolve against the parent's list — and let each " + 'row index into that. Note that a plural read still primes by PARTITION, not by the ids it asks for, so ' + "if this store's partition is coarse the parent read fetches all of it; where the rows are already to hand " + 'from the payload that listed them, prefer rendering from those and declaring `prime: false`.');
  });
}
function noteRead(store, argsKey) {
  if (fanoutWarned.has(store)) return;
  if (!fanoutTick) {
    fanoutTick = new Map();
    setTimeout(flushFanout, 0);
  }
  (0, _collections.getOrCreate)(fanoutTick, store, () => new Set()).add(argsKey);
}

/** Returns a {@link DataResult} whose identity is stable across renders while its parts hold. */
function useResult(data, status, isFetching, doRefetch) {
  return (0, _react.useMemo)(() => (0, _store_result.makeResult)(data, status, {
    isFetching,
    refetch: doRefetch
  }), [data, status, isFetching, doRefetch]);
}

/** What a read's value cache is keyed by beyond its partitions, resolved once per read. */
function varyResolver(def) {
  return def.varyBy ? (0, _partition_fields.varyValuesOf)(def.varyBy) : () => _args_key.EMPTY_VARY;
}

/**
 * Whether a read may prime its partitions and whether its `select` may run. Priming asks strictly less: a read
 * still waiting on a vary value primes anyway, so the rows are there when the value arrives.
 */
function readGates(def, args, addressable, vary) {
  return {
    // Absent means prime, so only an explicit `false` holds the fetch back.
    prime: addressable && def.prime !== false,
    read: addressable && vary.every(_args_key.isVaryPresent) && (def.enabled?.(args) ?? true)
  };
}

/** The status and `DataResult` every read ends with; `hasData` is a thunk, called once the read is known enabled. */
function useReadTail(data, enabled, hasData, prime, doRefetch) {
  const status = (0, _tracking.runSubscribed)(() => (0, _store_result.offHeapStatus)(enabled, enabled && hasData(), prime));
  return useResult(data, status, prime.isFetching, doRefetch);
}

/**
 * Builds the read engine over one store's partitions: `read` / `readMany` / `readGrouped` each take a descriptor and
 * hand back its `useValue` / `getValue` pair, with the priming, the version subscription, the presence gate and the
 * value cache already wrapped around `select`. `definePartitions` builds one per store, so stores declare reads.
 */
function createReadSurface(kernel) {
  const {
    ingest,
    toParts
  } = kernel;
  const versionOf = partitions => {
    let sum = 0;
    for (const parts of partitions) if ((0, _version_atom.addressesPartition)(parts)) sum += kernel.version.get(parts);
    return sum;
  };
  const usePriming = ingest?.usePrime ?? _prime_state.NO_PRIMING;
  const usePrimingAll = ingest?.usePrimeMany ?? _prime_state.NO_PRIMING;

  /** Whether each partition holds rows, keyed by partition and shared by every read on this surface. */
  const presenceByVersion = (0, _caches.createVersionedCache)(PRESENCE_CACHE_MAX);
  // Memoizable per version because presence only flips on a write, and every write bumps.
  const hasOne = (key, parts) => presenceByVersion.read((0, _args_key.cacheKey)(...parts), kernel.version.get(parts), () => kernel.has(key));
  const hasAny = entries => entries.some(entry => (0, _version_atom.addressesPartition)(entry.parts) && hasOne(entry.key, entry.parts));

  /** Starts a cold partition's fetch. Only `getValue` needs it; a reactive read primes through `usePrime`. */
  const primeIfCold = (key, parts) => {
    if (ingest && !hasOne(key, parts)) ingest.ensure(key);
  };
  const makeValueCache = def => (0, _caches.createVersionedCache)(def.getCacheMax ?? 256, def.isEqual ?? _caches.shallowEqualValue);
  function defineRead(def) {
    const getCache = makeValueCache(def);
    const spec = def.partition ?? kernel.defaultPartition;
    if (!spec) throw new Error(`${kernel.name ?? 'off_heap'}_store: this read needs a \`partition\`, since the store's key declares no \`fields\` to default to`);
    const keyOf = (0, _partition_fields.partitionKeyOf)(spec);
    const varyOf = varyResolver(def);
    const select = overArgs(def.select);
    const gatesFor = (args, parts, vary, wanted) => readGates(def, args, wanted && (0, _version_atom.addressesPartition)(parts), vary);
    const cached = (args, key, parts, argsKey) => getCache.read(argsKey, kernel.version.get(parts), () => select(args, key));
    function getValue(args) {
      if (args === undefined) return def.empty;
      const key = keyOf(args);
      const parts = toParts(key);
      if (!(0, _version_atom.addressesPartition)(parts)) return def.empty;
      // Must run on every call, cache hits included, or the enclosing tracking scope misses this dependency.
      kernel.version.get(parts);
      const vary = varyOf(args);
      const gates = gatesFor(args, parts, vary, true);
      if (gates.prime) primeIfCold(key, parts);
      if (!gates.read || !hasOne(key, parts)) return def.empty;
      return cached(args, key, parts, (0, _args_key.varyKey)(parts, vary));
    }
    function useValue(args, options) {
      // `partition`, `varyBy` and `select` assume a real partition; the hooks below still run, reading nothing.
      const key = args === undefined ? undefined : keyOf(args);
      const parts = key === undefined ? _version_atom.NO_PARTS : toParts(key);
      const vary = args === undefined ? _args_key.EMPTY_VARY : varyOf(args);
      const gates = gatesFor(args, parts, vary, (options?.enabled ?? true) && args !== undefined);
      const prime = usePriming(key, gates.prime);
      const argsKey = args === undefined ? NO_ARGS_KEY : (0, _args_key.varyKey)(parts, vary);
      if (__DEV__ && gates.read) noteRead(kernel.name ?? 'off_heap', argsKey);
      const data = kernel.version.useSelect(parts, gates.read, [argsKey], () => hasOne(key, parts) ? cached(args, key, parts, argsKey) : def.empty, def.isEqual ?? _caches.shallowEqualValue, def.empty);
      const doRefetch = (0, _react.useCallback)(() => {
        if (key !== undefined) ingest?.refetch(key);
      }, [argsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `argsKey` covers `key`
      return useReadTail(data, gates.read, () => (0, _version_atom.addressesPartition)(parts) && hasOne(key, parts), prime, doRefetch);
    }
    return {
      getValue,
      useValue,
      requires: def.requires ?? (0, _partition_fields.requiredFieldsOf)(spec, def.varyBy)
    };
  }

  /**
   * The engine behind `readMany` and `readGrouped`, which differ only in what `select` is handed back: the flat
   * keys, or the groups they were named in. `resolve` runs once per call because naming a partition may intern it.
   */
  function manyRead(def, resolve, select, noneNamed) {
    const getCache = makeValueCache(def);
    const varyOf = varyResolver(def);
    const cacheKeyOf = (partitions, vary) => (0, _args_key.varyKey)([(0, _args_key.partitionsKey)(partitions)], vary);
    const resolveOr = args => args === undefined ? {
      keys: NO_KEYS,
      named: noneNamed
    } : resolve(args);

    /** `read`'s gates over a set: addressable when at least one partition is, since the rest are gaps. */
    const gatesFor = (args, partitions, vary, wanted) => readGates(def, args, wanted && partitions.some(_version_atom.addressesPartition), vary);
    const cached = (args, named, partitions, argsKey) => getCache.read(argsKey, versionOf(partitions), () => select(args, named));
    function getValue(args) {
      if (args === undefined) return def.empty;
      const {
        keys,
        named
      } = resolve(args);
      const entries = (0, _version_atom.partitionEntries)(keys, toParts);
      const partitions = entries.map(entry => entry.parts);
      // Tracking, on every call — see `read.getValue`.
      versionOf(partitions);
      const vary = varyOf(args);
      const gates = gatesFor(args, partitions, vary, true);
      if (gates.prime) for (const entry of entries) if ((0, _version_atom.addressesPartition)(entry.parts)) primeIfCold(entry.key, entry.parts);
      if (!gates.read || !hasAny(entries)) return def.empty;
      return cached(args, named, partitions, cacheKeyOf(partitions, vary));
    }
    function useValue(args, options) {
      const {
        keys,
        named
      } = resolveOr(args);
      const entries = args === undefined ? [] : (0, _version_atom.partitionEntries)(keys, toParts);
      const partitions = args === undefined ? NO_PARTITIONS : entries.map(entry => entry.parts);
      const vary = args === undefined ? _args_key.EMPTY_VARY : varyOf(args);
      const gates = gatesFor(args, partitions, vary, (options?.enabled ?? true) && args !== undefined);
      const prime = usePrimingAll(keys, gates.prime);
      const argsKey = args === undefined ? NO_ARGS_KEY : cacheKeyOf(partitions, vary);
      const data = kernel.version.useSelectMany(partitions, gates.read, [argsKey], () => hasAny(entries) ? cached(args, named, partitions, argsKey) : def.empty, def.isEqual ?? _caches.shallowEqualValue, def.empty);
      const doRefetch = (0, _react.useCallback)(() => {
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