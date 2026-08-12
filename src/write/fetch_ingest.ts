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

const NO_TIMINGS = { staleTime: undefined, cacheTime: undefined };

/**
 * Builds a store's whole fetch half: one React Query query per partition that asks for the body conditionally on the
 * stored ETag, hands it to `ingestRaw`, and bumps the version the reads watch. `definePartitions` composes it from a
 * store's `fetch` spec, so a store author declares that spec rather than calling this.
 */
export function createFetchIngest<Key>(cfg: FetchIngestConfig<Key>): FetchIngest<Key> {
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
    const count = rawJson ? await cfg.ingestRaw(key, rawJson) : 0;
    recordTiming(count, rawJson ? rawJson.length : null);
    // Only for a body that was ingested: an etag saved from a bodyless 200 would 304 every later launch.
    if (res?.etag && rawJson) cfg.setEtag(key, res.etag);
    return { version: bump(key, parts), count };
  };

  /** A key's stale and cache times; `rawQuery` may throw during render, and the request itself surfaces that. */
  const timingsFor = (key: Key): { staleTime?: number; cacheTime?: number } => {
    try {
      return cfg.rawQuery(key);
    } catch {
      return NO_TIMINGS;
    }
  };

  function usePrime(key: Key | undefined, enabled?: boolean): PrimeState {
    const parts = key === undefined ? NO_PARTS : cfg.toParts(key);
    const isEnabled = (enabled ?? true) && isLive(parts);
    const timings = isEnabled ? timingsFor(key as Key) : NO_TIMINGS;
    // The runtime is installed once during startup, so which hook this resolves to is fixed for the app's lifetime.
    const result = queryRuntime().useQuery<{ version: number; count: number }>({
      queryKey: queryKey(parts),
      queryFn: () => runIngest(key as Key),
      enabled: isEnabled,
      staleTime: timings.staleTime,
      cacheTime: timings.cacheTime,
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
          const timings = timingsFor(key);
          return {
            queryKey: queryKey(parts),
            queryFn: () => runIngest(key),
            enabled,
            staleTime: timings.staleTime,
            cacheTime: timings.cacheTime,
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
    const timings = timingsFor(key);
    // Shares `usePrime`'s query key, so a partition a hook already primed resolves from the query cache.
    return queryRuntime().client().fetchQuery<{ version: number; count: number }>({
      queryKey: queryKey(parts),
      queryFn: () => runIngest(key),
      staleTime: opts?.staleTime ?? timings.staleTime,
      cacheTime: timings.cacheTime,
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
