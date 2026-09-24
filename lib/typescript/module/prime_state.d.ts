/**
 * The state of the fetch behind a read's partitions: whether it is loading for the first time, in flight, or failed.
 */
export interface PrimeState {
    /** Whether the first fetch is in flight and nothing has loaded yet. */
    isInitialLoading: boolean;
    /**
     * Whether a fetch is in flight, including a background refetch. Correct when read, but a change in it alone does
     * not re-render the reader; see `NOTIFY_ON_PRIME_STATE`. A spinner for a background refetch needs its own trigger;
     * one shown only before anything has loaded should use `isInitialLoading`.
     */
    isFetching: boolean;
    /** Whether the last fetch failed. */
    isError: boolean;
}
/**
 * The state of a partition with no fetch behind it: what `NO_PRIMING` hands a push-fed store's reads, and what a stub
 * ingest returns in a test. A read over one reports `success` rather than `loading`, however empty the partition is.
 */
export declare const PRIME_IDLE: PrimeState;
/** The prime hook a push-fed store gets. Bind it once in place of the real hook, never branch at call time. */
export declare const NO_PRIMING: () => PrimeState;
//# sourceMappingURL=prime_state.d.ts.map