/**
 * Kernel services for tests, as Jest mocks: every query call and error report is recorded, `fetchQuery` runs the
 * query's `queryFn`, and `useQuery` reports idle. Install once per test file, at module scope.
 */
/** The mocks {@link installTestRuntime} installs, one per service method. */
export interface TestRuntime {
    /** Runs the query's `queryFn`. */
    fetchQuery: jest.Mock;
    invalidateQueries: jest.Mock;
    removeQueries: jest.Mock;
    /** Returns an idle status. */
    useQuery: jest.Mock;
    /** Returns an idle status per query. */
    useQueries: jest.Mock;
    captureException: jest.Mock;
    captureMessage: jest.Mock;
}
/** Configures the kernel with Jest mocks for its query runtime and error sink, and returns them. */
export declare function installTestRuntime(): TestRuntime;
//# sourceMappingURL=runtime.d.ts.map