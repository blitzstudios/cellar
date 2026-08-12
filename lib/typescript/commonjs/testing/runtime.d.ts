/**
 * The host services a test installs into the kernel, as spies: every query call and every report is recorded, queries
 * resolve through their own `queryFn`, and a prime reports idle. Install once per test file, at module scope.
 */
export interface TestRuntime {
    fetchQuery: jest.Mock;
    invalidateQueries: jest.Mock;
    removeQueries: jest.Mock;
    useQuery: jest.Mock;
    useQueries: jest.Mock;
    captureException: jest.Mock;
    captureMessage: jest.Mock;
}
export declare function installTestRuntime(): TestRuntime;
//# sourceMappingURL=runtime.d.ts.map