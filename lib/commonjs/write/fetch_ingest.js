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
var _once_guard = require("../diagnostics/once_guard.js");
var _telemetry = require("../diagnostics/telemetry.js");
var _runtime = require("../runtime.js");
/** The fetch side of a store: runs the request, shreds the response into rows, and bumps the partition. */

/**
 * What a change in the fetch's state is allowed to repaint a reader for. Deliberately short of every field
 * {@link PrimeState} carries: `isFetching` is left out.
 *
 * `isFetching` toggles twice on every fetch, and each toggle wakes every reader primed on that partition — hundreds
 * of them across the app, for a flag that says only that a refresh is in flight. What it does not say is that
 * anything changed; the rows arriving is a version bump, and that is what repaints a read. So this leaves it
 * unobserved rather than unavailable: `result.isFetching` is still read fresh at render, it just no longer causes a
 * render of its own. The first load stays reactive, since `isInitialLoading` covers exactly the case of a fetch in
 * flight with nothing yet to show.
 */
const NOTIFY_ON_PRIME_STATE = ['isInitialLoading', 'isError'];

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
 * Fingerprints a body without allocating, in one pass, as djb2 and sdbm — two polynomial hashes whose bases (33 and
 * 65599) are far enough apart to fail independently.
 *
 * Both are shift-and-add rather than `Math.imul`, which is what keeps this affordable: the multiplies, not the walk,
 * were most of the cost. Measured on Hermes over a 1.5M-character body, hashing adds 8.8ms to a 31.5ms traversal that
 * no JS fingerprint can avoid, against 34.9ms for a pair using `imul`.
 */
function fingerprintOf(body) {
  const length = body.length;
  let djb = 5381;
  let sdbm = 0;
  for (let index = 0; index < length; index += 1) {
    const code = body.charCodeAt(index);
    djb = (djb << 5) + djb + code | 0;
    sdbm = code + (sdbm << 6) + (sdbm << 16) - sdbm | 0;
  }
  return {
    length,
    djb: djb >>> 0,
    sdbm: sdbm >>> 0
  };
}
function sameBody(left, right) {
  return !!left && left.length === right.length && left.djb === right.djb && left.sdbm === right.sdbm;
}

/**
 * A partition's fetch as the rest of the kernel drives it: the priming hooks a read mounts, and the imperative starts,
 * refetches and invalidations `definePartitions` republishes as a store's `lifecycle` group.
 */

/**
 * The timings for a hook holding its position while addressing nothing: no keys at all, rather than keys carrying
 * `undefined`.
 *
 * React Query reads `staleTime` off the observer with a `= 0` default, and `defaultQueryOptions` merges by spread, so
 * a key that is *present* and `undefined` overrides the client's configured default and lands on 0 — data is stale the
 * moment it arrives. Omitting the key lets the default stand. A store's partition has real timings whether or not a
 * given caller is enabled, so `timingsFor` is asked for them either way and this is only for an absent key.
 */
const NO_TIMINGS = {};

/**
 * Above this, one partition landing is worth knowing about. Priming is by partition and a read of a slice pays for
 * the whole of it, so these are sized to catch a partition big enough that serving a handful of rows out of it is a
 * bad trade — not to accuse it of being one, which only the call site knows. Tune them here rather than at a site.
 */
/**
 * What a priming caller wants of the partition. `slice` says it will select part of it, which is the only shape where
 * an oversized ingest is worth reporting — everyone else asked for the rows they got.
 */

const OVERSIZED_PRIME_ROWS = 5_000;
const OVERSIZED_PRIME_CHARS = 2_000_000;
const oversizedPrimeReported = (0, _once_guard.createOnceGuard)();

/**
 * Files an oversized partition ingest, once per partition per session.
 *
 * This is the only thing that notices, deliberately. Priming stays automatic and unremarked, because that is the
 * whole point of the layer and because a declaration cannot answer this anyway: whether fetching a partition to
 * serve a slice is worth it depends on who is calling and what else they hold, and a read has no view of either.
 * Nor could a static answer stay true — a partition small enough to ignore when the read was written may not be
 * next season.
 *
 * So nobody declares anything and the ingest reports what it actually cost. `info`, not `error`: a large partition
 * is not a fault, and the store may well mean it.
 *
 * It reports only where the advice applies: a read that selects a slice. A partition somebody asked for outright —
 * a prime hook, or a read with no `varyBy` — cost what it was asked for, and reporting it taught the reader to
 * ignore the channel. An app priming its own sports at startup is the case that made this necessary.
 */
function reportOversizedPrime(store, partition, rows, chars, wantedWhole) {
  // Somebody asked for this partition outright — a prime hook, or a read that selects all of it. The rows are what
  // they asked for, and `prime: false` is not advice that applies, so there is nothing to say.
  if (wantedWhole) return;
  if (rows < OVERSIZED_PRIME_ROWS && (chars ?? 0) < OVERSIZED_PRIME_CHARS) return;
  if (oversizedPrimeReported.seen(store, partition)) return;
  (0, _telemetry.reportStoreDegradation)({
    scope: `${store}.oversized_prime.${partition}`,
    context: `priming the '${partition}' partition landed ${rows} rows / ${chars ?? 0} chars. Priming is by partition, so ` + 'every read of this partition pays this whether it selects one row or all of them. If the reads here want a ' + 'slice, check whether the payload that named those rows already carries what they render, and declare ' + '`prime: false` on the read if so.',
    severity: 'info',
    extra: {
      store,
      partition,
      rows,
      chars
    }
  });
}

/**
 * Builds a store's whole fetch half: one React Query query per partition that asks for the body conditionally on the
 * stored ETag, hands it to `ingestRaw`, and bumps the version the reads watch. `definePartitions` composes it from a
 * store's `fetch` spec, so a store author declares that spec rather than calling this.
 */
function createFetchIngest(cfg) {
  /** The body each partition last shredded, so a refetch that brings the same one back can stop before it does. */
  const ingestedBodies = new Map();
  /**
   * Partitions some caller has asked for whole, which is what decides whether an oversized ingest is worth reporting.
   * Set during the priming hook rather than counted across mounts: the report fires once per partition per session,
   * so the question is only ever whether such a caller has existed, and a refcount would cost an effect per read.
   */
  const wantedWhole = new Set();
  /**
   * Whether an identical body has to be *detected* rather than simply shredded again, which is what decides if every
   * body is worth hashing. Only a store taking concurrent socket writes can be harmed by re-shredding one: the body
   * is older than any delta that landed since, so replacing the rows with it undoes them. Without that write path the
   * cost of missing the case is a repaint, which does not pay for a pass over every character of every body.
   */
  const detectsUnchangedBodies = !!cfg.holdWrites;
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
      const partition = (0, _args_key.partitionLabel)(parts);
      (0, _ingest_timing.recordIngestTiming)({
        store: cfg.ingestKeyRoot,
        partition,
        fetchMs: fetchedAt - startedAt,
        ingestMs: at - fetchedAt,
        chars,
        rows,
        at
      });
      // A 304 and an unchanged body report negative rows and shredded nothing, so neither is a prime worth flagging.
      if (rows > 0) reportOversizedPrime(cfg.ingestKeyRoot, partition, rows, chars, wantedWhole.has(partition));
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
    const fingerprint = detectsUnchangedBodies ? fingerprintOf(rawJson) : undefined;
    const partitionId = (0, _args_key.partitionsKey)([parts]);
    if (fingerprint && sameBody(ingestedBodies.get(partitionId), fingerprint)) {
      // The same body we already shredded, on a partition that also takes socket writes — so this is the wrong body
      // to write, not merely a redundant one: it is older than any delta that landed since it was shredded, and
      // replacing the rows with it would undo them. Stopping here also spares the repaint, since a bump is what every
      // read watches and none of them has anything new to show.
      recordTiming(ROWS_UNCHANGED, rawJson.length);
      if (res?.etag) cfg.setEtag(key, res.etag);
      return {
        version: cfg.version.get(parts),
        count: ROWS_UNCHANGED
      };
    }
    const count = await cfg.ingestRaw(key, rawJson);
    recordTiming(count, rawJson.length);
    if (fingerprint) {
      if (ingestedBodies.size >= FINGERPRINT_CAPACITY) ingestedBodies.clear();
      ingestedBodies.set(partitionId, fingerprint);
    }
    // Only for a body that was ingested: an etag saved from a bodyless 200 would 304 every later launch.
    if (res?.etag) cfg.setEtag(key, res.etag);
    return {
      version: bump(key, parts),
      count
    };
  };

  /**
   * A key's stale and cache times and nothing else, safe to spread into a query spec: `rawQuery` hands back the whole
   * request, `queryFn` included, and spreading that would replace the ingest with the bare request. A time the store
   * left undefined is left out rather than copied over, so it cannot override a configured default with `undefined`.
   *
   * `rawQuery` may throw during render — a locator short of a value — and the request itself surfaces that.
   */
  const timingsFor = key => {
    let raw;
    try {
      raw = cfg.rawQuery(key);
    } catch {
      return NO_TIMINGS;
    }
    const timings = {};
    if (raw.staleTime !== undefined) timings.staleTime = raw.staleTime;
    if (raw.cacheTime !== undefined) timings.cacheTime = raw.cacheTime;
    return timings;
  };
  function usePrime(key, enabled, opts) {
    const parts = key === undefined ? _version_atom.NO_PARTS : cfg.toParts(key);
    const isEnabled = (enabled ?? true) && (0, _version_atom.addressesPartition)(parts);
    if (!opts?.slice && (0, _version_atom.addressesPartition)(parts)) wantedWhole.add((0, _args_key.partitionLabel)(parts));
    // Asked for whenever the key names a partition, not only when this caller is enabled. A disabled caller still
    // constructs the observer, and an observer constructed without a staleTime treats its data as stale on arrival —
    // it then fetches when it is enabled, however fresh the cache is.
    const timings = key === undefined ? NO_TIMINGS : timingsFor(key);
    // The runtime is installed once during startup, so which hook this resolves to is fixed for the app's lifetime.
    const result = (0, _runtime.queryRuntime)().useQuery({
      queryKey: queryKey(parts),
      queryFn: () => runIngest(key),
      enabled: isEnabled,
      ...timings,
      notifyOnChangeProps: NOTIFY_ON_PRIME_STATE
    });
    return {
      isInitialLoading: result.isInitialLoading,
      isFetching: result.isFetching,
      isError: result.isError
    };
  }
  function usePrimeMany(keys, enabled = true, opts) {
    // `useFocusGatedQueries` keys on this array's identity, and callers rebuild it each render, so memo on contents.
    const addressable = (0, _version_atom.partitionEntries)(keys, cfg.toParts).filter(entry => (0, _version_atom.addressesPartition)(entry.parts));
    if (!opts?.slice) for (const entry of addressable) wantedWhole.add((0, _args_key.partitionLabel)(entry.parts));
    const identity = (0, _args_key.partitionsKey)(addressable.map(entry => entry.parts));
    const queries = (0, _react.useMemo)(() => addressable.map(({
      key,
      parts
    }) => {
      return {
        queryKey: queryKey(parts),
        queryFn: () => runIngest(key),
        enabled,
        ...timingsFor(key),
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
    if (!(0, _version_atom.addressesPartition)(parts)) return Promise.resolve({
      version: cfg.version.get(parts),
      count: 0
    });
    // Shares `usePrime`'s query key, so a partition a hook already primed resolves from the query cache — and that is
    // `staleTime`'s decision, so the timings are spread rather than named, to keep an absent one absent.
    return (0, _runtime.queryRuntime)().client().fetchQuery({
      queryKey: queryKey(parts),
      queryFn: () => runIngest(key),
      ...timingsFor(key),
      ...(opts?.staleTime === undefined ? {} : {
        staleTime: opts.staleTime
      })
    });
  }
  function ensure(key) {
    prefetch(key).catch(() => {
      // Best-effort: a mounted hook or the next ingest still repaints.
    });
  }
  function invalidate(key) {
    const parts = cfg.toParts(key);
    if (!(0, _version_atom.addressesPartition)(parts)) return;
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