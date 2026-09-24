/** The fetch side of a store: runs the request, shreds the response into rows, and bumps the partition. */
import { VersionAtom } from '../reactivity/version_atom';
import { PrimeState } from '../prime_state';
import { ChangeSet, WriteResult } from '../table/change_set';
/** The response a partition's query resolves to. */
export interface RawFetchResponse {
    /** The response body, ideally as unparsed text. */
    data?: unknown;
    /** The response's ETag, sent with the partition's next request. */
    etag?: string;
    /** Set when the server answered 304 Not Modified, in which case the partition's rows are left as they are. */
    __etagMatch?: boolean;
}
/** A partition's request, as `fetch.query` returns it; the kernel runs it through React Query. */
export interface RawQuery {
    /** Makes the request. */
    queryFn: () => Promise<RawFetchResponse | undefined>;
    /** How long a fetched partition counts as fresh, in ms. */
    staleTime?: number;
    /** How long an unused query stays cached, in ms. */
    cacheTime?: number;
}
/** How {@link createFetchIngest} fetches a store's partitions. `definePartitions` builds this for a store. */
export interface FetchIngestConfig<Key> {
    /** The first element of every partition's React Query key. */
    ingestKeyRoot: string;
    /** The store's version atom, bumped when a fetch changes rows. */
    version: VersionAtom;
    /** A partition's key parts. */
    toParts: (key: Key) => readonly string[];
    /** The partition's request, sending `etag` when there is one. */
    rawQuery: (key: Key, etag?: string) => RawQuery;
    /** The partition's stored ETag. */
    getEtag: (key: Key) => string | undefined;
    /** Stores the partition's ETag. */
    setEtag: (key: Key, etag: string) => void;
    /** Replaces the partition's rows with the body's, returning which units changed and how many rows the body held. */
    ingestRaw: (key: Key, rawJson: string) => Promise<WriteResult>;
    /** Tells the partition's readers which units a fetch changed, returning the new version. */
    bump?: (key: Key, changes: ChangeSet) => number;
    /**
     * Holds the partition's socket pushes during the request, since `ingestRaw` replaces its rows; returns the release.
     */
    holdWrites?: (key: Key) => () => void;
}
/**
 * An axios `transformResponse` that keeps a response body as text. Our axios (0.15.3) parses string bodies as JSON
 * whatever `responseType` says.
 */
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