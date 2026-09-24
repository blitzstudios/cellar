/** The result every store read returns: a subset of React Query's `UseQueryResult`, which an RQ result satisfies. */
import { PrimeState } from './prime_state';
/** A read's status, with React Query's names, so a screen can switch on it the same way for either. */
export type DataStatus = 'loading' | 'success' | 'error';
/**
 * What a read's hook returns: the value and the state of the fetch behind it. These are the fields of React Query's
 * result that screens use, so a call site can switch between a `useQuery` and a store read without changes.
 */
export interface DataResult<T> {
    /** The read's value, or its `empty` while there are no rows yet or the read is disabled. */
    data: T;
    /**
     * `loading` while the first fetch is in flight and there are no rows yet, `error` if that fetch failed, and
     * otherwise `success`, including for a disabled read.
     */
    status: DataStatus;
    /** Whether `status` is `loading`. */
    isLoading: boolean;
    /**
     * Whether a fetch is in flight, including a background refetch. Correct when read, but a change in it alone does
     * not re-render the screen; see {@link PrimeState.isFetching}.
     */
    isFetching: boolean;
    /** Whether `status` is `success`. */
    isSuccess: boolean;
    /** Whether `status` is `error`. */
    isError: boolean;
    /** Fetches the partition again. */
    refetch: () => void;
}
/** The names of every {@link DataResult} field, which the app's lint rule uses to check which fields a screen reads. */
export declare const DATA_RESULT_KEYS: readonly ["data", "status", "isLoading", "isFetching", "isSuccess", "isError", "refetch"];
/**
 * Builds a {@link DataResult} from a value and a status, deriving the `is*` flags from the status. For a hook the
 * kernel's reads can't express, such as one returning a result per item in a list; declared reads already return one.
 */
export declare function makeResult<T>(data: T, status: DataStatus, opts?: {
    /** Whether a fetch is in flight; defaults to whether `status` is `loading`. */
    isFetching?: boolean;
    /** What `refetch` calls; does nothing by default. */
    refetch?: () => void;
}): DataResult<T>;
/** The status a read reports: rows present outrank the fetch, and a push-fed store settles on `success`. */
export declare function offHeapStatus(enabled: boolean, hasData: boolean, prime: PrimeState): DataStatus;
//# sourceMappingURL=store_result.d.ts.map