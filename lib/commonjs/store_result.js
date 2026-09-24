"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.DATA_RESULT_KEYS = void 0;
exports.makeResult = makeResult;
exports.offHeapStatus = offHeapStatus;
/** The result every store read returns: a subset of React Query's `UseQueryResult`, which an RQ result satisfies. */

/** A read's status, with React Query's names, so a screen can switch on it the same way for either. */

/**
 * What a read's hook returns: the value and the state of the fetch behind it. These are the fields of React Query's
 * result that screens use, so a call site can switch between a `useQuery` and a store read without changes.
 */

/** The names of every {@link DataResult} field, which the app's lint rule uses to check which fields a screen reads. */
const DATA_RESULT_KEYS = exports.DATA_RESULT_KEYS = ['data', 'status', 'isLoading', 'isFetching', 'isSuccess', 'isError', 'refetch'];
const NOOP_REFETCH = () => {};

/**
 * Builds a {@link DataResult} from a value and a status, deriving the `is*` flags from the status. For a hook the
 * kernel's reads can't express, such as one returning a result per item in a list; declared reads already return one.
 */
function makeResult(data, status, opts) {
  const isLoading = status === 'loading';
  return {
    data,
    status,
    isLoading,
    isFetching: opts?.isFetching ?? isLoading,
    isSuccess: status === 'success',
    isError: status === 'error',
    refetch: opts?.refetch ?? NOOP_REFETCH
  };
}

/** The status a read reports: rows present outrank the fetch, and a push-fed store settles on `success`. */
function offHeapStatus(enabled, hasData, prime) {
  if (!enabled) return 'success';
  if (hasData) return 'success';
  if (prime.isError) return 'error';
  return prime.isInitialLoading ? 'loading' : 'success';
}
//# sourceMappingURL=store_result.js.map