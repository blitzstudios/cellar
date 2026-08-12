/** The result every store read returns: a subset of React Query's `UseQueryResult`, which an RQ result satisfies. */

import { PrimeState } from './prime_state';

/** The three states a read reports, spelled as React Query spells them, so a screen switching on one need not know where its value came from. */
export type DataStatus = 'loading' | 'success' | 'error';

/**
 * The envelope a read hands back: the value, and what is known about the fetch behind it. It is the part of React
 * Query's result a screen actually reads, so a call site moves between a `useQuery` and a store read unchanged.
 */
export interface DataResult<T> {
  data: T;
  status: DataStatus;
  isLoading: boolean;
  isFetching: boolean;
  isSuccess: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * Every field a {@link DataResult} carries. `eslint-plugin-sleeper` reads this to decide which fields a screen may
 * take off a read, so the rule and the type cannot drift.
 */
export const DATA_RESULT_KEYS = ['data', 'status', 'isLoading', 'isFetching', 'isSuccess', 'isError', 'refetch'] as const satisfies readonly (keyof DataResult<unknown>)[];

const NOOP_REFETCH = (): void => {};

/**
 * Fills a {@link DataResult} from a value and a status, deriving the booleans so no caller can spell a contradictory
 * pair. Reach for it in a bespoke read the read surface cannot express, such as a hook returning one result per item in
 * a list; every read declared through `read` / `readMany` is wrapped for you.
 */
export function makeResult<T>(data: T, status: DataStatus, opts?: { isFetching?: boolean; refetch?: () => void }): DataResult<T> {
  const isLoading = status === 'loading';
  return {
    data,
    status,
    isLoading,
    isFetching: opts?.isFetching ?? isLoading,
    isSuccess: status === 'success',
    isError: status === 'error',
    refetch: opts?.refetch ?? NOOP_REFETCH,
  };
}

/** The status a read reports: rows present outrank the fetch, and a push-fed store settles on `success`. */
export function offHeapStatus(enabled: boolean, hasData: boolean, prime: PrimeState): DataStatus {
  if (!enabled) return 'success';
  if (hasData) return 'success';
  if (prime.isError) return 'error';
  return prime.isInitialLoading ? 'loading' : 'success';
}
