"use strict";

/**
 * The host services a test installs into the kernel, as spies: every query call and every report is recorded, queries
 * resolve through their own `queryFn`, and a prime reports idle. Install once per test file, at module scope.
 */

import { configureDataKernel } from "../runtime.js";
const IDLE = {
  isInitialLoading: false,
  isFetching: false,
  isError: false
};
export function installTestRuntime() {
  const spies = {
    fetchQuery: jest.fn(spec => spec.queryFn()),
    invalidateQueries: jest.fn(),
    removeQueries: jest.fn(),
    useQuery: jest.fn(() => IDLE),
    useQueries: jest.fn(({
      queries
    }) => queries.map(() => IDLE)),
    captureException: jest.fn(),
    captureMessage: jest.fn()
  };
  configureDataKernel({
    errors: {
      captureException: (error, context) => spies.captureException(error, context),
      captureMessage: (message, context) => spies.captureMessage(message, context)
    },
    query: {
      client: () => ({
        fetchQuery: spec => spies.fetchQuery(spec),
        invalidateQueries: filters => spies.invalidateQueries(filters),
        removeQueries: filters => spies.removeQueries(filters)
      }),
      useQuery: spec => spies.useQuery(spec),
      useQueries: specs => spies.useQueries(specs)
    }
  });
  return spies;
}
//# sourceMappingURL=runtime.js.map