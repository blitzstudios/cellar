/** A bounded ring of what the recent fetch-fed ingests cost, each split into network wait and shred. */
/**
 * One partition's fetch, as the diagnostics dump reports it: how long the request took against how long the shred did,
 * with the body's size and the row count to read them against. This is what says whether a slow load was the network
 * or the ingest.
 */
export interface IngestTiming {
    store: string;
    partition: string;
    fetchMs: number;
    ingestMs: number;
    chars: number | null;
    /** `-1` when the fetch 304'd, `-2` when it brought back a body identical to the one already shredded. */
    rows: number;
    at: number;
}
/** One store's share of the recorded ingests, totalled: which store a session spent its fetch and shred time in. */
export interface IngestRollup {
    store: string;
    fetches: number;
    fetchMs: number;
    ingestMs: number;
    chars: number;
    rows: number;
}
/** Files one ingest in the ring, which the fetch does for every partition it lands, 304s included. */
export declare function recordIngestTiming(timing: IngestTiming): void;
/**
 * The ingests still in the ring, oldest first, for a caller that wants them one by one — the developer overlay's
 * diagnostics dump takes them this way and rolls them up beside it. The ring keeps only the most recent, so a dump
 * taken deep into a session no longer holds the launch's.
 */
export declare function getIngestTimings(): IngestTiming[];
/** Empties the ring, so what a measurement or a test reads back is only what it caused. */
export declare function clearIngestTimings(): void;
/**
 * The recorded ingests totalled per store, costliest first — the summary to read before the individual timings, since
 * it names which store to look at. 304s count as fetches and carry no rows, so they show as time spent for nothing new.
 */
export declare function rollupIngestTimings(timings?: readonly IngestTiming[]): IngestRollup[];
//# sourceMappingURL=ingest_timing.d.ts.map