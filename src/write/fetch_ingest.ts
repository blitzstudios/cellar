/** The fetch side of a store: runs the request, shreds the response into rows, and bumps the partition. */

import { useMemo } from 'react';

import { partitionLabel, partitionsKey } from '../args_key';
import { isLive, NO_PARTS, partitionEntries, VersionAtom } from '../reactivity/version_atom';
import { PrimeState } from '../prime_state';
import { recordIngestTiming } from '../diagnostics/ingest_timing';
import { queryRuntime } from '../runtime';

const NOTIFY_ON_PRIME_STATE = ['isInitialLoading', 'isFetching', 'isError'] as const;

/**
 * What the ingest reads off a store's request, and so the shape a `write/raw_query.ts` has to hand back: the undecoded
 * body, the ETag to keep for the next conditional request, and the flag the API layer sets when the server answered
 * 304. On a 304 the body is whatever was already cached, so the ingest stops and leaves the partition's rows alone.
 */
export interface RawFetchResponse {
  data?: unknown;
  etag?: string;
  __etagMatch?: boolean;
}

/**
 * A store's request described but not run — the React Query descriptor `write/raw_query.ts` builds and a partition's
 * `fetch.query` returns. Its `staleTime` / `cacheTime` are the partition's refetch policy, since the kernel, not the
 * store, is what mounts the query.
 */
export interface RawQuery {
  queryFn: () => Promise<RawFetchResponse | undefined>;
  staleTime?: number;
  cacheTime?: number;
}

/** A store's fetch side, keyed by whatever names a partition. Prefer `definePartitions`, which derives it. */
export interface FetchIngestConfig<Key> {
  ingestKeyRoot: string;
  version: VersionAtom;
  toParts: (key: Key) => readonly string[];
  rawQuery: (key: Key, etag?: string) => RawQuery;
  getEtag: (key: Key) => string | undefined;
  setEtag: (key: Key, etag: string) => void;
  ingestRaw: (key: Key, rawJson: string) => Promise<number>;
  bump?: (key: Key) => number;
  /** Held for the length of the request: `ingestRaw` replaces the partition, so socket writes queue behind it. */
  holdWrites?: (key: Key) => () => void;
}

/** An identity transform that keeps a body as text: axios 0.15.3 ignores `responseType` and parses string bodies. */
export const RAW_TEXT_RESPONSE_TRANSFORM = [(data: unknown): unknown => data];

function coerceRawJson(data: unknown): string | undefined {
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
interface BodyFingerprint {
  length: number;
  djb: number;
  sdbm: number;
}

/**
 * Fingerprints a body without allocating, in one pass, as djb2 and sdbm — two polynomial hashes whose bases (33 and
 * 65599) are far enough apart to fail independently.
 *
 * Both are shift-and-add rather than `Math.imul`, which is what keeps this affordable: the multiplies, not the walk,
 * were most of the cost. Measured on Hermes over a 1.5M-character body, hashing adds 8.8ms to a 31.5ms traversal that
 * no JS fingerprint can avoid, against 34.9ms for a pair using `imul`.
 */
function fingerprintOf(body: string): BodyFingerprint {
  const length = body.length;
  let djb = 5381;
  let sdbm = 0;
  for (let index = 0; index < length; index += 1) {
    const code = body.charCodeAt(index);
    djb = ((djb << 5) + djb + code) | 0;
    sdbm = (code + (sdbm << 6) + (sdbm << 16) - sdbm) | 0;
  }
  return { length, djb: djb >>> 0, sdbm: sdbm >>> 0 };
}

function sameBody(left: BodyFingerprint | undefined, right: BodyFingerprint): boolean {
  return !!left && left.length === right.length && left.djb === right.djb && left.sdbm === right.sdbm;
}

/**
 * A partition's fetch as the rest of the kernel drives it: the priming hooks a read mounts, and the imperative starts,
 * refetches and invalidations `definePartitions` republishes as a store's `lifecycle` group.
 */
export interface FetchIngest<Key> {
  /** `undefined` holds the hook's position in the render and leaves it idle. */
  usePrime: (key: Key | undefined, enabled?: boolean) => PrimeState;
  usePrimeMany: (keys: readonly Key[], enabled?: boolean) => PrimeState;
  ensure: (key: Key) => void;
  /** Resolves once the fetch and ingest land, or immediately when the partition is fresh or in flight. */
  prefetch: (key: Key, opts?: { staleTime?: number }) => Promise<{ version: number; count: number }>;
  /** Fetches the partition again, whatever it already holds. */
  refetch: (key: Key) => void;
  invalidate: (key: Key) => void;
  /** Discards every partition's fetch record, so each one reads as cold again. */
  forget: () => void;
}

/**
 * The timings for a hook holding its position while addressing nothing: no keys at all, rather than keys carrying
 * `undefined`.
 *
 * React Query reads `staleTime` off the observer with a `= 0` default, and `defaultQueryOptions` merges by spread, so
 * a key that is *present* and `undefined` overrides the client's configured default and lands on 0 — data is stale the
 * moment it arrives. Omitting the key lets the default stand. A store's partition has real timings whether or not a
 * given caller is enabled, so `timingsFor` is asked for them either way and this is only for an absent key.
 */
const NO_TIMINGS: { staleTime?: number; cacheTime?: number } = {};

/**
 * Builds a store's whole fetch half: one React Query query per partition that asks for the body conditionally on the
 * stored ETag, hands it to `ingestRaw`, and bumps the version the reads watch. `definePartitions` composes it from a
 * store's `fetch` spec, so a store author declares that spec rather than calling this.
 */
export function createFetchIngest<Key>(cfg: FetchIngestConfig<Key>): FetchIngest<Key> {
  /** The body each partition last shredded, so a refetch that brings the same one back can stop before it does. */
  const ingestedBodies = new Map<string, BodyFingerprint>();
  /**
   * Whether an identical body has to be *detected* rather than simply shredded again, which is what decides if every
   * body is worth hashing. Only a store taking concurrent socket writes can be harmed by re-shredding one: the body
   * is older than any delta that landed since, so replacing the rows with it undoes them. Without that write path the
   * cost of missing the case is a repaint, which does not pay for a pass over every character of every body.
   */
  const detectsUnchangedBodies = !!cfg.holdWrites;
  const queryKey = (parts: readonly string[]): (string | undefined)[] => [cfg.ingestKeyRoot, ...parts];
  const bump = (key: Key, parts: readonly string[]): number => (cfg.bump ? cfg.bump(key) : cfg.version.bump(parts));

  const runIngest = async (key: Key): Promise<{ version: number; count: number }> => {
    const release = cfg.holdWrites?.(key);
    try {
      return await fetchAndIngest(key);
    } finally {
      release?.();
    }
  };

  const fetchAndIngest = async (key: Key): Promise<{ version: number; count: number }> => {
    const parts = cfg.toParts(key);
    const etag = cfg.getEtag(key);
    const startedAt = Date.now();
    const res = await cfg.rawQuery(key, etag).queryFn();
    const fetchedAt = Date.now();
    const recordTiming = (rows: number, chars: number | null): void => {
      const at = Date.now();
      recordIngestTiming({
        store: cfg.ingestKeyRoot,
        partition: partitionLabel(parts),
        fetchMs: fetchedAt - startedAt,
        ingestMs: at - fetchedAt,
        chars,
        rows,
        at,
      });
    };

    if (res?.__etagMatch) {
      // `-1` distinguishes a 304 from an ingest that landed zero rows.
      recordTiming(-1, null);
      return { version: cfg.version.get(parts), count: -1 };
    }

    const rawJson = coerceRawJson(res?.data);
    if (!rawJson) {
      // A 200 carrying nothing to shred. `ingestRaw` never runs, so no rows changed and there is nothing for a bump
      // to tell anyone about — bumping here would invalidate every read on the partition to republish what it holds.
      recordTiming(0, null);
      return { version: cfg.version.get(parts), count: 0 };
    }

    const fingerprint = detectsUnchangedBodies ? fingerprintOf(rawJson) : undefined;
    const partitionId = partitionsKey([parts]);
    if (fingerprint && sameBody(ingestedBodies.get(partitionId), fingerprint)) {
      // The same body we already shredded, on a partition that also takes socket writes — so this is the wrong body
      // to write, not merely a redundant one: it is older than any delta that landed since it was shredded, and
      // replacing the rows with it would undo them. Stopping here also spares the repaint, since a bump is what every
      // read watches and none of them has anything new to show.
      recordTiming(ROWS_UNCHANGED, rawJson.length);
      if (res?.etag) cfg.setEtag(key, res.etag);
      return { version: cfg.version.get(parts), count: ROWS_UNCHANGED };
    }

    const count = await cfg.ingestRaw(key, rawJson);
    recordTiming(count, rawJson.length);
    if (fingerprint) {
      if (ingestedBodies.size >= FINGERPRINT_CAPACITY) ingestedBodies.clear();
      ingestedBodies.set(partitionId, fingerprint);
    }
    // Only for a body that was ingested: an etag saved from a bodyless 200 would 304 every later launch.
    if (res?.etag) cfg.setEtag(key, res.etag);
    return { version: bump(key, parts), count };
  };

  /**
   * A key's stale and cache times and nothing else, safe to spread into a query spec: `rawQuery` hands back the whole
   * request, `queryFn` included, and spreading that would replace the ingest with the bare request. A time the store
   * left undefined is left out rather than copied over, so it cannot override a configured default with `undefined`.
   *
   * `rawQuery` may throw during render — a locator short of a value — and the request itself surfaces that.
   */
  const timingsFor = (key: Key): { staleTime?: number; cacheTime?: number } => {
    let raw: RawQuery;
    try {
      raw = cfg.rawQuery(key);
    } catch {
      return NO_TIMINGS;
    }
    const timings: { staleTime?: number; cacheTime?: number } = {};
    if (raw.staleTime !== undefined) timings.staleTime = raw.staleTime;
    if (raw.cacheTime !== undefined) timings.cacheTime = raw.cacheTime;
    return timings;
  };

  function usePrime(key: Key | undefined, enabled?: boolean): PrimeState {
    const parts = key === undefined ? NO_PARTS : cfg.toParts(key);
    const isEnabled = (enabled ?? true) && isLive(parts);
    // Asked for whenever the key names a partition, not only when this caller is enabled. A disabled caller still
    // constructs the observer, and an observer constructed without a staleTime treats its data as stale on arrival —
    // it then fetches when it is enabled, however fresh the cache is.
    const timings = key === undefined ? NO_TIMINGS : timingsFor(key);
    // The runtime is installed once during startup, so which hook this resolves to is fixed for the app's lifetime.
    const result = queryRuntime().useQuery<{ version: number; count: number }>({
      queryKey: queryKey(parts),
      queryFn: () => runIngest(key as Key),
      enabled: isEnabled,
      ...timings,
      notifyOnChangeProps: NOTIFY_ON_PRIME_STATE,
    });
    return { isInitialLoading: result.isInitialLoading, isFetching: result.isFetching, isError: result.isError };
  }

  function usePrimeMany(keys: readonly Key[], enabled = true): PrimeState {
    // `useFocusGatedQueries` keys on this array's identity, and callers rebuild it each render, so memo on contents.
    const addressable = partitionEntries(keys, cfg.toParts).filter((entry) => isLive(entry.parts));
    const identity = partitionsKey(addressable.map((entry) => entry.parts));
    const queries = useMemo(
      () =>
        addressable.map(({ key, parts }) => {
          return {
            queryKey: queryKey(parts),
            queryFn: () => runIngest(key),
            enabled,
            ...timingsFor(key),
            notifyOnChangeProps: NOTIFY_ON_PRIME_STATE,
          };
        }),
      [identity, enabled], // eslint-disable-line react-hooks/exhaustive-deps -- `identity` covers `addressable`
    );
    const results = queryRuntime().useQueries({ queries });
    // Failed only if *every* partition failed, so one bad partition degrades to a gap in the list.
    return {
      isInitialLoading: results.some((result) => result.isInitialLoading),
      isFetching: results.some((result) => result.isFetching),
      isError: results.length > 0 && results.every((result) => result.isError),
    };
  }

  function prefetch(key: Key, opts?: { staleTime?: number }): Promise<{ version: number; count: number }> {
    const parts = cfg.toParts(key);
    if (!isLive(parts)) return Promise.resolve({ version: cfg.version.get(parts), count: 0 });
    // Shares `usePrime`'s query key, so a partition a hook already primed resolves from the query cache — and that is
    // `staleTime`'s decision, so the timings are spread rather than named, to keep an absent one absent.
    return queryRuntime().client().fetchQuery<{ version: number; count: number }>({
      queryKey: queryKey(parts),
      queryFn: () => runIngest(key),
      ...timingsFor(key),
      ...(opts?.staleTime === undefined ? {} : { staleTime: opts.staleTime }),
    });
  }

  function ensure(key: Key): void {
    prefetch(key).catch(() => {
      // Best-effort: a mounted hook or the next ingest still repaints.
    });
  }

  function invalidate(key: Key): void {
    const parts = cfg.toParts(key);
    if (!isLive(parts)) return;
    // The etag survives, so an unchanged partition costs a 304 and stops there.
    queryRuntime().client().invalidateQueries({ queryKey: queryKey(parts), exact: true });
  }

  function refetch(key: Key): void {
    invalidate(key);
    ensure(key);
  }

  function forget(): void {
    // Removed so the data goes with the record: an invalidated query keeps its data, and a mounted reader shows it.
    queryRuntime().client().removeQueries({ queryKey: [cfg.ingestKeyRoot] });
  }

  return { usePrime, usePrimeMany, ensure, prefetch, refetch, invalidate, forget };
}
