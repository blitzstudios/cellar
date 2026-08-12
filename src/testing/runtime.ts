/**
 * The host services a test installs into the kernel, as spies: every query call and every report is recorded, queries
 * resolve through their own `queryFn`, and a prime reports idle. Install once per test file, at module scope.
 */

import { configureDataKernel, QuerySpec, QueryStatus } from '../runtime';

const IDLE: QueryStatus = { isInitialLoading: false, isFetching: false, isError: false };

export interface TestRuntime {
  fetchQuery: jest.Mock;
  invalidateQueries: jest.Mock;
  removeQueries: jest.Mock;
  useQuery: jest.Mock;
  useQueries: jest.Mock;
  captureException: jest.Mock;
  captureMessage: jest.Mock;
}

export function installTestRuntime(): TestRuntime {
  const spies: TestRuntime = {
    fetchQuery: jest.fn((spec: QuerySpec<unknown>) => spec.queryFn()),
    invalidateQueries: jest.fn(),
    removeQueries: jest.fn(),
    useQuery: jest.fn(() => IDLE),
    useQueries: jest.fn(({ queries }: { queries: readonly QuerySpec<unknown>[] }) => queries.map(() => IDLE)),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
  };

  configureDataKernel({
    errors: {
      captureException: (error, context) => spies.captureException(error, context),
      captureMessage: (message, context) => spies.captureMessage(message, context),
    },
    query: {
      client: () => ({
        fetchQuery: (spec) => spies.fetchQuery(spec) as Promise<never>,
        invalidateQueries: (filters) => spies.invalidateQueries(filters),
        removeQueries: (filters) => spies.removeQueries(filters),
      }),
      useQuery: (spec) => spies.useQuery(spec),
      useQueries: (specs) => spies.useQueries(specs),
    },
  });

  return spies;
}
