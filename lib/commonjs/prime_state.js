"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.PRIME_IDLE = exports.NO_PRIMING = void 0;
/**
 * The state of the fetch behind a read's partitions: whether it is loading for the first time, in flight, or failed.
 */

/**
 * The state of a partition with no fetch behind it: what `NO_PRIMING` hands a push-fed store's reads, and what a stub
 * ingest returns in a test. A read over one reports `success` rather than `loading`, however empty the partition is.
 */
const PRIME_IDLE = exports.PRIME_IDLE = {
  isInitialLoading: false,
  isFetching: false,
  isError: false
};

/** The prime hook a push-fed store gets. Bind it once in place of the real hook, never branch at call time. */
const NO_PRIMING = () => PRIME_IDLE;
exports.NO_PRIMING = NO_PRIMING;
//# sourceMappingURL=prime_state.js.map