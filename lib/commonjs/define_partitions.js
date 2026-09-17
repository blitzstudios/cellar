"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.definePartitions = definePartitions;
var _react = require("react");
var _args_key = require("./args_key.js");
var _fetch_ingest = require("./write/fetch_ingest.js");
var _surface = require("./read/surface.js");
var _caches = require("./caches.js");
var _version_atom = require("./reactivity/version_atom.js");
var _partition_fields = require("./read/partition_fields.js");
var _projection = require("./read/projection.js");
var _prime_state = require("./prime_state.js");
var _store_result = require("./store_result.js");
var _telemetry = require("./diagnostics/telemetry.js");
var _tracking = require("./reactivity/tracking.js");
/**
 * A store's rows divided into partitions: the addressable slice a fetch replaces, a version tracks, and an ETag
 * belongs to. From `key.where` alone this derives presence, what a fetch replaces, where the ETag lives, and what
 * a write bumps.
 */

/** No partition: args still being filled in, or a slot a caller left empty, which keeps its index in the result. */

/**
 * A store reaches its key from a read's args one of two ways: `fields` names the args fields that spell the key,
 * or `of` + `id` map a partition record too big to be a key, which this module interns so a fetch gets it back.
 */

/** How a partition's rows are fetched. Omit for a store fed by socket pushes. */

/**
 * One store's declaration of its partitions: the table they divide, the version atom they bump, where a key's rows
 * live, and how a body becomes them. `onChanged` is the hook for a store holding a rollup derived from a partition,
 * such as a ranking over it, which new rows invalidate.
 */

/**
 * The partition operations a caller outside the read path reaches for. Every member takes the same args a read
 * does, in the `(args, options?)` shape a backend publishes, so a store publishes the group as-is. The two priming
 * hooks take them loosely, as a screen holds them: they are called unconditionally, from a fixed hook position, and
 * args short of the value that names a partition prime nothing.
 */

/** Args that carry the read's partitions in the field of that name, where `readMany` looks by default. */

/** Where a read's partitions come from; `null` and `undefined` both stand for an empty set. */

/** `readMany`, naming its partitions as the records a caller holds. Optional when the args already carry them. */

/** `readGrouped`, likewise: one group of candidate records per thing the caller is asking about. */

/**
 * Everything one `definePartitions` call hands a backend: the three read constructors it declares its reads with, the
 * row-filter and version primitives its hydration and its own writes are built from, and a `lifecycle` group ready to
 * publish as-is.
 */

const INTERN_MAX = 512;
const NO_INTERNED = Object.freeze([]);
/** The empty descriptor list `readMany` falls back on when args name no partitions. */
const NO_DESCRIPTORS = Object.freeze([]);

/**
 * The middle layer of a store, and the call its backend is built around: answer where one partition's rows live
 * (`key.where`) and how a response body becomes them (`fetch`), and get back the reads, the ETag handling, the priming
 * and the version bumps derived from those answers. Called once per store, from `buildXBackend` after `table.init()`.
 */
function definePartitions(config) {
  const {
    name,
    table,
    version,
    key: keySpec,
    fetch: fetchSpec
  } = config;
  const where = keySpec.where;

  /** A key's parts: its positional form, which reaches only as far as the version and query keys. */
  const fields = keySpec.fields;
  const toParts = !fields ? key => [key ?? ''] : fields.length === 1 ? key => [key[fields[0]] ?? ''] : key => fields.map(field => key[field] ?? '');

  /** The record⇄key mapping. Bounded; every path to a key re-registers, so a live partition's entry stays warm. */
  const toId = keySpec.id;
  const interned = toId ? (0, _caches.createBoundedLru)(config.internMax ?? INTERN_MAX) : undefined;
  const keyOf = partition => {
    if (!toId || !interned) return partition;
    const key = toId(partition);
    interned.set(key, partition);
    return key;
  };
  /** The key an absent partition maps to: all-empty parts, which `addressesPartition` rejects, so nothing is read or primed. */
  const GAP_KEY = fields ? Object.freeze({}) : '';
  const keyOfMaybe = partition => partition == null ? GAP_KEY : keyOf(partition);
  const describe = key => {
    if (!interned) return key;
    const partition = interned.get(key);
    if (!partition) throw new Error(`${name}_store: unknown partition ${String(key)}`);
    return partition;
  };

  /** How a read and every `lifecycle` member gets from args to the key; `key.of` reads them at their loosest. */
  const keyOfArgs = keySpec.of ? args => keyOfMaybe(keySpec.of(args)) : !fields ? args => args :
  // The fields are named against `Key` and here pick out of `Args`, which `defaultPartition` already requires.
  (0, _partition_fields.partitionKeyOf)(fields);
  const bump = key => {
    const next = version.bump(toParts(key));
    config.onChanged?.(key, next);
    return next;
  };

  /** When each partition's rows last landed. Bounded, and a forgotten timestamp reads as never-fetched. */
  const fetchedAt = (0, _caches.createBoundedLru)(config.internMax ?? INTERN_MAX);

  /** Replaces the partition's rows, through the native shred where the body allows it and JS parsing otherwise. */
  async function ingestRaw(key, rawJson) {
    const spec = fetchSpec;
    const partition = describe(key);
    const rowsWhere = where(key);
    const parse = raw => spec.parse(partition, raw, key);
    const inJs = () => table.overwrite(rowsWhere, parse(rawJson));
    let count;
    if (spec.canShredNatively?.(partition) === false) {
      count = inJs();
    } else {
      try {
        count = await table.shred(rowsWhere, rawJson, parse);
      } catch (error) {
        (0, _telemetry.reportStoreDegradation)({
          scope: `${name}_store.raw_ingest`,
          context: 'async raw ingest failed; re-parsed and retried through the synchronous path',
          error,
          extra: {
            store: name,
            partition: (0, _args_key.partitionLabel)(toParts(key))
          }
        });
        count = inJs();
      }
    }
    fetchedAt.set((0, _args_key.cacheKey)(...toParts(key)), Date.now());
    return count;
  }
  const ingest = fetchSpec ? (0, _fetch_ingest.createFetchIngest)({
    ingestKeyRoot: `${name}_store_ingest`,
    version,
    toParts,
    rawQuery: interned ? (key, etag) => fetchSpec.query(describe(key), etag) : fetchSpec.query,
    getEtag: key => table.getMeta(where(key)),
    setEtag: (key, etag) => table.setMeta(where(key), etag),
    ingestRaw,
    bump,
    holdWrites: fetchSpec.holdWrites
  }) : undefined;
  const surface = (0, _surface.createReadSurface)({
    name,
    version,
    toParts,
    has: key => table.has(where(key)),
    defaultPartition: keySpec.of ? keyOfArgs : fields,
    ingest
  });

  /** Whether the partition holds rows. Tracks, since the surface's probe takes the version on every call. */
  const has = key => surface.has(key);
  const versionOf = key => version.get(toParts(key));

  // Bound once, so the hook a component calls is the same one on every render.
  const usePriming = ingest?.usePrime ?? _prime_state.NO_PRIMING;
  const usePrimingAll = ingest?.usePrimeMany ?? _prime_state.NO_PRIMING;

  /**
   * The key a priming hook's args address. Args short of a value are `keyOfArgs`' business as usual: a missing field
   * becomes an empty part and `key.of` answers `null`, and either way `addressesPartition` rejects the key, so nothing is primed.
   */
  const keyOfHookArgs = args => keyOfArgs(args);
  function usePrimeAndVersion(args, options) {
    const key = args === undefined ? undefined : keyOfHookArgs(args);
    const parts = key === undefined ? _version_atom.NO_PARTS : toParts(key);
    const isEnabled = (options?.enabled ?? true) && key !== undefined && (0, _version_atom.addressesPartition)(parts);
    const prime = usePriming(key, isEnabled);
    const ver = version.useVersion(parts, isEnabled);
    const partsKey = (0, _args_key.cacheKey)(...parts);
    const status = (0, _tracking.runSubscribed)(() => (0, _store_result.offHeapStatus)(isEnabled, isEnabled && surface.has(key), prime));
    const doRefetch = (0, _react.useCallback)(() => {
      if (key !== undefined) ingest?.refetch(key);
    }, [partsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `partsKey` covers `key`
    return (0, _surface.useResult)(ver, status, prime.isFetching, doRefetch);
  }

  /** Both set reads name their partitions as records; the keys they address are this layer's to resolve. */
  function readManyOf() {
    return def => {
      const named = def.partitions ?? (args => args.partitions);
      return surface.readMany()({
        ...def,
        partitions: args => (named(args) ?? NO_DESCRIPTORS).map(keyOfMaybe)
      });
    };
  }
  function readGroupedOf() {
    return def => {
      const groups = args => def.groups(args).map(group => group.map(keyOfMaybe));
      return surface.readGrouped()({
        ...def,
        groups
      });
    };
  }
  return {
    read: surface.read,
    readMany: readManyOf,
    readGrouped: readGroupedOf,
    memos: decls => (0, _caches.createMemos)(name, {
      parts: toParts,
      version: versionOf
    }, decls),
    project: () => def => {
      const bound = (0, _caches.createMemos)(name, {
        parts: toParts,
        version: versionOf
      }, {
        [def.name]: (0, _projection.rowVmMemo)(def.max)
      });
      return (0, _projection.createRowProjection)({
        store: name,
        table,
        filter: where,
        memo: bound[def.name]
      }, def);
    },
    where,
    keyOf,
    internedKeys: () => interned ? interned.keys() : NO_INTERNED[Symbol.iterator](),
    has,
    versionOf,
    bump,
    clearEtag: key => table.setMeta(where(key), undefined),
    lifecycle: {
      usePrime: (args, options) => usePriming(args === undefined ? undefined : keyOfHookArgs(args), options?.enabled ?? true),
      usePrimeMany: (args, options) => usePrimingAll(args.map(keyOfArgs), options?.enabled ?? true),
      usePrimeAndVersion,
      has: args => has(keyOfArgs(args)),
      getVersion: args => versionOf(keyOfArgs(args)),
      getFetchedAt: args => {
        const parts = toParts(keyOfArgs(args));
        // Read for its tracking side effect, so a derivation gating on this getter hears about the change.
        version.get(parts);
        return fetchedAt.get((0, _args_key.cacheKey)(...parts)) ?? 0;
      },
      fetch: (args, options) => ingest ? ingest.prefetch(keyOfArgs(args), options).then(() => undefined) : Promise.resolve(),
      refetch: args => ingest?.refetch(keyOfArgs(args)),
      invalidate: args => ingest?.invalidate(keyOfArgs(args)),
      forget: () => ingest?.forget()
    }
  };
}
//# sourceMappingURL=define_partitions.js.map