/** What a read knows about the fetch behind its partition: whether it is loading, in flight, or has failed. */
export interface PrimeState {
    isInitialLoading: boolean;
    isFetching: boolean;
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