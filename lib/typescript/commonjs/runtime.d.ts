/**
 * The three services the kernel takes from its host rather than owning: where a report goes, the React Query
 * runtime an ingest mounts on, and when a read is live. A host calls
 * {@link configureDataKernel} once during startup, before it binds any store's backend. Until it does, each stays
 * inert, so a store still reads its rows and a test still renders.
 */
/** The Sentry-shaped context a kernel report carries. */
export interface CaptureContext {
    tags?: Record<string, string>;
    fingerprint?: string[];
    extra?: Record<string, unknown>;
}
/** Where a kernel report goes, shaped like the two Sentry calls it stands in for so a host wires it in one line. */
export interface ErrorSink {
    captureException: (error: unknown, context: CaptureContext) => void;
    captureMessage: (message: string, context: CaptureContext & {
        level: 'info';
    }) => void;
}
/** A query key as the kernel builds it: the ingest root, then the partition's parts. */
export type QueryKey = readonly (string | undefined)[];
/** One partition's conditional fetch as the kernel hands it over, for the host to gate and mount. */
export interface QuerySpec<T> {
    queryKey: QueryKey;
    queryFn: () => Promise<T>;
    enabled?: boolean;
    staleTime?: number;
    cacheTime?: number;
    notifyOnChangeProps?: readonly string[];
}
/** The three fields a prime reports to the read that mounted it. */
export interface QueryStatus {
    isInitialLoading: boolean;
    isFetching: boolean;
    isError: boolean;
}
/** The imperative half of the runtime, behind `prefetch`, `invalidate`, `refetch` and `forget`. */
export interface QueryClient {
    fetchQuery: <T>(spec: {
        queryKey: QueryKey;
        queryFn: () => Promise<T>;
        staleTime?: number;
        cacheTime?: number;
    }) => Promise<T>;
    invalidateQueries: (filters: {
        queryKey: QueryKey;
        exact?: boolean;
    }) => void;
    removeQueries: (filters: {
        queryKey: QueryKey;
    }) => void;
}
/**
 * The query runtime a store's fetch side runs on. `useQuery` and `useQueries` are hooks, so a host passes its own
 * focus-gated drop-ins and keeps that policy. `client` is read per call, letting a host install it after this.
 */
export interface QueryRuntime {
    client: () => QueryClient;
    useQuery: <T>(spec: QuerySpec<T>) => QueryStatus;
    useQueries: <T>(specs: {
        queries: readonly QuerySpec<T>[];
    }) => readonly QueryStatus[];
}
/**
 * Whether a read should still be taking writes, and how to hear about that changing.
 *
 * The kernel never learns why a gate went dead — a blurred screen, a hidden subtree, a backgrounded app are all the
 * same boolean to it, and the host owns which of those count. It is deliberately not a boolean returned from a hook
 * either: this gates a read's *subscription*, not its render. A read that re-rendered when the gate moved would wake
 * every screen in the stack on each navigation, which is the cost being avoided.
 */
export interface ReadGate {
    /** While false, reads under this gate hold the value they last had and stop taking writes. */
    isLive: () => boolean;
    /** Fires on every transition, both directions. Must not re-render the caller. */
    onChange: (listener: () => void) => () => void;
}
/**
 * The host's policy for when a read is live. `useReadGate` is a hook so it can read the enclosing subtree's owner
 * from context.
 *
 * It MUST return a reference-stable gate for as long as that owner is the same one — the kernel keys its
 * subscription on the gate's identity, so one rebuilt each render would resubscribe each render.
 */
export interface ReadGateRuntime {
    useReadGate: () => ReadGate;
}
/** Everything a host supplies. Each part may be configured on its own. */
export interface DataKernelRuntime {
    errors: ErrorSink;
    query: QueryRuntime;
    gate: ReadGateRuntime;
}
/** Drops every report. The default until a host configures one. */
export declare const INERT_ERRORS: ErrorSink;
/**
 * Holds each hook's position in the render and stays idle, so a store whose host never configured a runtime renders
 * and reads instead of breaking the rules of hooks.
 */
export declare const INERT_QUERY: QueryRuntime;
export declare const INERT_GATE: ReadGateRuntime;
/**
 * Installs a host's services. Each part given replaces the one before it, so a host may configure error reporting,
 * the query runtime and the read gate from different places, and a test may install one and leave the rest inert.
 */
export declare function configureDataKernel(next: Partial<DataKernelRuntime>): void;
export declare function errorSink(): ErrorSink;
export declare function queryRuntime(): QueryRuntime;
export declare function readGateRuntime(): ReadGateRuntime;
//# sourceMappingURL=runtime.d.ts.map