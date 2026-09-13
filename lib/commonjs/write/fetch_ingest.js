"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RAW_TEXT_RESPONSE_TRANSFORM = void 0;
exports.createFetchIngest = createFetchIngest;
var _react = require("react");
var _args_key = require("../args_key.js");
var _version_atom = require("../reactivity/version_atom.js");
var _ingest_timing = require("../diagnostics/ingest_timing.js");
var _runtime = require("../runtime.js");
/** The fetch side of a store: runs the request, shreds the response into rows, and bumps the partition. */

const NOTIFY_ON_PRIME_STATE = ['isInitialLoading', 'isFetching', 'isError'];

/**
 * What the ingest reads off a store's request, and so the shape a `write/raw_query.ts` has to hand back: the undecoded
 * body, the ETag to keep for the next conditional request, and the flag the API layer sets when the server answered
 * 304. On a 304 the body is whatever was already cached, so the ingest stops and leaves the partition's rows alone.
 */

/**
 * A store's request described but not run — the React Query descriptor `write/raw_query.ts` builds and a partition's
 * `fetch.query` returns. Its `staleTime` / `cacheTime` are the partition's refetch policy, since the kernel, not the
 * store, is what mounts the query.
 */

/** A store's fetch side, keyed by whatever names a partition. Prefer `definePartitions`, which derives it. */

/** An identity transform that keeps a body as text: axios 0.15.3 ignores `responseType` and parses string bodies. */
const RAW_TEXT_RESPONSE_TRANSFORM = exports.RAW_TEXT_RESPONSE_TRANSFORM = [data => data];
function coerceRawJson(data) {
  if (typeof data === 'string') return data;
  return data != null ? JSON.stringify(data) : undefined;
}

/** `rows` on a recorded ingest that shredded nothing because the body matched the one already shredded. */
const ROWS_UNCHANGED = -2;

/**
 * How many partitions' body fingerprints to keep. Far above the number a session addresses, so the bound only exists
 * so a long session cannot grow this without limit.
 */
const FINGERPRINT_CAPACITY = 512;

/** A body, as two independent 32-bit hashes and its length — 96 bits, so a false match is not a practical concern. */

/**
 * Fingerprints a body without allocating, in one pass, using two hashes with different constants and mixing.
 *
 * This runs on every fetched body, so it has to be cheap relative to what it saves. It is a charCodeAt loop and two
 * multiplies per character against a shred that parses the same string and writes a row per record — on the bodies
 * where this matters, hashing is a small fraction of the shred it skips.
 */
function fingerprintOf(body) {
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index);
    fnv = Math.imul(fnv ^ code, 0x01000193);
    djb = Math.imul(djb, 33) + code | 0;
  }
  return {
    length: body.length,
    fnv: fnv >>> 0,
    djb: djb >>> 0
  };
}
function sameBody(left, right) {
  return !!left && left.length === right.length && left.fnv === right.fnv && left.djb === right.djb;
}

/**
 * A partition's fetch as the rest of the kernel drives it: the priming hooks a read mounts, and the imperative starts,
 * refetches and invalidations `definePartitions` republishes as a store's `lifecycle` group.
 */

const NO_TIMINGS = {
  staleTime: undefined,
  cacheTime: undefined
};

/**
 * Builds a store's whole fetch half: one React Query query per partition that asks for the body conditionally on the
 * stored ETag, hands it to `ingestRaw`, and bumps the version the reads watch. `definePartitions` composes it from a
 * store's `fetch` spec, so a store author declares that spec rather than calling this.
 */
function createFetchIngest(cfg) {
  /** The body each partition last shredded, so a refetch that brings the same one back can stop before it does. */
  const ingestedBodies = new Map();
  const queryKey = parts => [cfg.ingestKeyRoot, ...parts];
  const bump = (key, parts) => cfg.bump ? cfg.bump(key) : cfg.version.bump(parts);
  const runIngest = async key => {
    const release = cfg.holdWrites?.(key);
    try {
      return await fetchAndIngest(key);
    } finally {
      release?.();
    }
  };
  const fetchAndIngest = async key => {
    const parts = cfg.toParts(key);
    const etag = cfg.getEtag(key);
    const startedAt = Date.now();
    const res = await cfg.rawQuery(key, etag).queryFn();
    const fetchedAt = Date.now();
    const recordTiming = (rows, chars) => {
      const at = Date.now();
      (0, _ingest_timing.recordIngestTiming)({
        store: cfg.ingestKeyRoot,
        partition: (0, _args_key.partitionLabel)(parts),
        fetchMs: fetchedAt - startedAt,
        ingestMs: at - fetchedAt,
        chars,
        rows,
        at
      });
    };
    if (res?.__etagMatch) {
      // `-1` distinguishes a 304 from an ingest that landed zero rows.
      recordTiming(-1, null);
      return {
        version: cfg.version.get(parts),
        count: -1
      };
    }
    const rawJson = coerceRawJson(res?.data);
    if (!rawJson) {
      // A 200 carrying nothing to shred. `ingestRaw` never runs, so no rows changed and there is nothing for a bump
      // to tell anyone about — bumping here would invalidate every read on the partition to republish what it holds.
      recordTiming(0, null);
      return {
        version: cfg.version.get(parts),
        count: 0
      };
    }
    const fingerprint = fingerprintOf(rawJson);
    const partitionId = (0, _args_key.partitionsKey)([parts]);
    if (sameBody(ingestedBodies.get(partitionId), fingerprint)) {
      // The same body we already shredded. Re-shredding it would rewrite every row to the value it already holds and
      // bump the partition, and a bump is what every read watches, so an unchanged partition would repaint all of
      // them. For a socket-fed partition it is also the wrong answer: an unchanged body is older than any delta that
      // has landed since it was shredded, so replacing the rows with it would undo them.
      recordTiming(ROWS_UNCHANGED, rawJson.length);
      if (res?.etag) cfg.setEtag(key, res.etag);
      return {
        version: cfg.version.get(parts),
        count: ROWS_UNCHANGED
      };
    }
    const count = await cfg.ingestRaw(key, rawJson);
    recordTiming(count, rawJson.length);
    if (ingestedBodies.size >= FINGERPRINT_CAPACITY) ingestedBodies.clear();
    ingestedBodies.set(partitionId, fingerprint);
    // Only for a body that was ingested: an etag saved from a bodyless 200 would 304 every later launch.
    if (res?.etag) cfg.setEtag(key, res.etag);
    return {
      version: bump(key, parts),
      count
    };
  };

  /** A key's stale and cache times; `rawQuery` may throw during render, and the request itself surfaces that. */
  const timingsFor = key => {
    try {
      return cfg.rawQuery(key);
    } catch {
      return NO_TIMINGS;
    }
  };
  function usePrime(key, enabled) {
    const parts = key === undefined ? _version_atom.NO_PARTS : cfg.toParts(key);
    const isEnabled = (enabled ?? true) && (0, _version_atom.isLive)(parts);
    const timings = isEnabled ? timingsFor(key) : NO_TIMINGS;
    // The runtime is installed once during startup, so which hook this resolves to is fixed for the app's lifetime.
    const result = (0, _runtime.queryRuntime)().useQuery({
      queryKey: queryKey(parts),
      queryFn: () => runIngest(key),
      enabled: isEnabled,
      staleTime: timings.staleTime,
      cacheTime: timings.cacheTime,
      notifyOnChangeProps: NOTIFY_ON_PRIME_STATE
    });
    return {
      isInitialLoading: result.isInitialLoading,
      isFetching: result.isFetching,
      isError: result.isError
    };
  }
  function usePrimeMany(keys, enabled = true) {
    // `useFocusGatedQueries` keys on this array's identity, and callers rebuild it each render, so memo on contents.
    const addressable = (0, _version_atom.partitionEntries)(keys, cfg.toParts).filter(entry => (0, _version_atom.isLive)(entry.parts));
    const identity = (0, _args_key.partitionsKey)(addressable.map(entry => entry.parts));
    const queries = (0, _react.useMemo)(() => addressable.map(({
      key,
      parts
    }) => {
      const timings = timingsFor(key);
      return {
        queryKey: queryKey(parts),
        queryFn: () => runIngest(key),
        enabled,
        staleTime: timings.staleTime,
        cacheTime: timings.cacheTime,
        notifyOnChangeProps: NOTIFY_ON_PRIME_STATE
      };
    }), [identity, enabled] // eslint-disable-line react-hooks/exhaustive-deps -- `identity` covers `addressable`
    );
    const results = (0, _runtime.queryRuntime)().useQueries({
      queries
    });
    // Failed only if *every* partition failed, so one bad partition degrades to a gap in the list.
    return {
      isInitialLoading: results.some(result => result.isInitialLoading),
      isFetching: results.some(result => result.isFetching),
      isError: results.length > 0 && results.every(result => result.isError)
    };
  }
  function prefetch(key, opts) {
    const parts = cfg.toParts(key);
    if (!(0, _version_atom.isLive)(parts)) return Promise.resolve({
      version: cfg.version.get(parts),
      count: 0
    });
    const timings = timingsFor(key);
    // Shares `usePrime`'s query key, so a partition a hook already primed resolves from the query cache.
    return (0, _runtime.queryRuntime)().client().fetchQuery({
      queryKey: queryKey(parts),
      queryFn: () => runIngest(key),
      staleTime: opts?.staleTime ?? timings.staleTime,
      cacheTime: timings.cacheTime
    });
  }
  function ensure(key) {
    prefetch(key).catch(() => {
      // Best-effort: a mounted hook or the next ingest still repaints.
    });
  }
  function invalidate(key) {
    const parts = cfg.toParts(key);
    if (!(0, _version_atom.isLive)(parts)) return;
    // The etag survives, so an unchanged partition costs a 304 and stops there.
    (0, _runtime.queryRuntime)().client().invalidateQueries({
      queryKey: queryKey(parts),
      exact: true
    });
  }
  function refetch(key) {
    invalidate(key);
    ensure(key);
  }
  function forget() {
    // Removed so the data goes with the record: an invalidated query keeps its data, and a mounted reader shows it.
    (0, _runtime.queryRuntime)().client().removeQueries({
      queryKey: [cfg.ingestKeyRoot]
    });
  }
  return {
    usePrime,
    usePrimeMany,
    ensure,
    prefetch,
    refetch,
    invalidate,
    forget
  };
}
//# sourceMappingURL=fetch_ingest.js.map