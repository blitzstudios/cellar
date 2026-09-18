/** The fetch side of a store: runs the request, shreds the response into rows, and bumps the partition. */
import { VersionAtom } from '../reactivity/version_atom';
import { PrimeState } from '../prime_state';
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
export declare const RAW_TEXT_RESPONSE_TRANSFORM: ((data: unknown) => unknown)[];
/**
 * A partition's fetch as the rest of the kernel drives it: the priming hooks a read mounts, and the imperative starts,
 * refetches and invalidations `definePartitions` republishes as a store's `lifecycle` group.
 */
export interface FetchIngest<Key> {
    /** `undefined` holds the hook's position in the render and leaves it idle. */
    usePrime: (key: Key | undefined, enabled?: boolean, opts?: PrimeIntent) => PrimeState;
    usePrimeMany: (keys: readonly Key[], enabled?: boolean, opts?: PrimeIntent) => PrimeState;
    ensure: (key: Key) => void;
    /** Resolves once the fetch and ingest land, or immediately when the partition is fresh or in flight. */
    prefetch: (key: Key, opts?: {
        staleTime?: number;
    }) => Promise<{
        version: number;
        count: number;
    }>;
    /** Fetches the partition again, whatever it already holds. */
    refetch: (key: Key) => void;
    invalidate: (key: Key) => void;
    /** Discards every partition's fetch record, so each one reads as cold again. */
    forget: () => void;
}
/**
 * Above this, one partition landing is worth knowing about. Priming is by partition and a read of a slice pays for
 * the whole of it, so these are sized to catch a partition big enough that serving a handful of rows out of it is a
 * bad trade — not to accuse it of being one, which only the call site knows. Tune them here rather than at a site.
 */
/**
 * What a priming caller wants of the partition. `slice` says it will select part of it, which is the only shape where
 * an oversized ingest is worth reporting — everyone else asked for the rows they got.
 */
export interface PrimeIntent {
    slice?: boolean;
}
/**
 * Builds a store's whole fetch half: one React Query query per partition that asks for the body conditionally on the
 * stored ETag, hands it to `ingestRaw`, and bumps the version the reads watch. `definePartitions` composes it from a
 * store's `fetch` spec, so a store author declares that spec rather than calling this.
 */
export declare function createFetchIngest<Key>(cfg: FetchIngestConfig<Key>): FetchIngest<Key>;
//# sourceMappingURL=fetch_ingest.d.ts.map