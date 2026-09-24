/**
 * The three services the app provides to the kernel: where error reports go, the React Query runtime fetches run on,
 * and when a read is live. The app calls {@link configureDataKernel} once at startup, before binding any store. Until
 * then each does nothing, so stores still read their rows and tests still render.
 */

import { createOnceGuard } from './diagnostics/once_guard';

/** The extra context sent with a kernel error report, in Sentry's shape. */
export interface CaptureContext {
  /** Searchable tags, such as the store's name. */
  tags?: Record<string, string>;
  /** Groups reports into one issue. */
  fingerprint?: string[];
  /** Details attached to the report. */
  extra?: Record<string, unknown>;
}

/**
 * Where the kernel sends error reports. Shaped like Sentry's two capture calls, so the app can pass Sentry's directly.
 */
export interface ErrorSink {
  /** Reports an error. */
  captureException: (error: unknown, context: CaptureContext) => void;
  /** Reports a message that isn't an error, such as a one-time notice. */
  captureMessage: (
    message: string,
    context: CaptureContext & {
      /** The report's level, always `info`. */
      level: 'info';
    },
  ) => void;
}

/** A React Query key built by the kernel: the store's query root, then the partition's key parts. */
export type QueryKey = readonly (string | undefined)[];

/** One partition's fetch, as the kernel passes it to the app's `useQuery`. The fields are React Query's. */
export interface QuerySpec<T> {
  /** The partition's query key. */
  queryKey: QueryKey;
  /** Fetches the partition and writes its rows. */
  queryFn: () => Promise<T>;
  /** Whether the query should run. */
  enabled?: boolean;
  /** How long a fetched partition counts as fresh, in ms. */
  staleTime?: number;
  /** How long an unused query stays cached, in ms. */
  cacheTime?: number;
  /** Which result fields re-render the caller when they change. */
  notifyOnChangeProps?: readonly string[];
}

/** The fields of a `useQuery` result the kernel reads. */
export interface QueryStatus {
  /** Whether the first fetch is in flight and nothing has loaded yet. */
  isInitialLoading: boolean;
  /** Whether a fetch is in flight. */
  isFetching: boolean;
  /** Whether the last fetch failed. */
  isError: boolean;
}

/** The parts of React Query's `QueryClient` the kernel uses for `prefetch`, `invalidate`, `refetch` and `forget`. */
export interface QueryClient {
  /** Fetches a query, or returns its cached result if still fresh. */
  fetchQuery: <T>(spec: Pick<QuerySpec<T>, 'queryKey' | 'queryFn' | 'staleTime' | 'cacheTime'>) => Promise<T>;
  /** Marks matching queries stale, refetching the ones in use. */
  invalidateQueries: (filters: {
    /** The key to match; queries whose key starts with it match, unless `exact`. */
    queryKey: QueryKey;
    /** Matches only a query with exactly this key. */
    exact?: boolean;
  }) => void;
  /** Removes matching queries from the cache. */
  removeQueries: (filters: {
    /** The key to match; queries whose key starts with it match. */
    queryKey: QueryKey;
  }) => void;
}

/**
 * The React Query runtime store fetches run on. The app passes its own hooks, which can add policy such as pausing on
 * blur.
 */
export interface QueryRuntime {
  /** Returns the query client. Called on each use, so the app can create the client after configuring the kernel. */
  client: () => QueryClient;
  /** React Query's `useQuery`, or a drop-in for it. */
  useQuery: <T>(spec: QuerySpec<T>) => QueryStatus;
  /** React Query's `useQueries`, or a drop-in for it. */
  useQueries: <T>(specs: {
    /** The queries to run. */
    queries: readonly QuerySpec<T>[];
  }) => readonly QueryStatus[];
}

/**
 * Tells reads whether they are live, meaning they take writes and update. A read that isn't live keeps its last value
 * until it is live again. The app decides what makes a read not live, such as its screen being blurred.
 *
 * It is a getter and a listener rather than a hook's return value, because it controls whether a read subscribes to
 * writes, not whether it renders. If a change in it re-rendered reads, every screen in the stack would re-render on
 * each navigation.
 */
export interface ReadGate {
  /** Whether reads under this gate are live. */
  isLive: () => boolean;
  /** Subscribes to changes in `isLive`, returning an unsubscribe. The listener must not re-render its caller. */
  onChange: (listener: () => void) => () => void;
}

/** The app's policy for when reads are live. */
export interface ReadGateRuntime {
  /**
   * Returns the gate for the component calling it, typically its screen's, read from context. Must return the same
   * object for as long as that screen stays the same, since a read resubscribes whenever the gate object changes.
   */
  useReadGate: () => ReadGate;
}

/** The services the app provides to the kernel. */
export interface DataKernelRuntime {
  /** Where error reports go. */
  errors: ErrorSink;
  /** The React Query runtime fetches run on. */
  query: QueryRuntime;
  /** When reads are live. */
  gate: ReadGateRuntime;
}

const unconfigured = createOnceGuard();

function warnUnconfigured(what: string): void {
  if (!__DEV__ || unconfigured.seen(what)) return;
  // eslint-disable-next-line no-console
  console.warn(
    `data_kernel.unconfigured: ${what} was used before \`configureDataKernel\` ran. Reads still answer from the rows ` +
      'already stored, but nothing fetches. Call `configureDataKernel` during startup, before binding a store.',
  );
}

/** An error sink that drops every report; the default until the app configures one. */
export const INERT_ERRORS: ErrorSink = {
  captureException: () => {},
  captureMessage: () => {},
};

const IDLE: QueryStatus = Object.freeze({ isInitialLoading: false, isFetching: false, isError: false });
const NO_STATUSES: readonly QueryStatus[] = Object.freeze([]);

const INERT_CLIENT: QueryClient = {
  fetchQuery: () => {
    warnUnconfigured('a partition prefetch');
    return Promise.reject(new Error('data_kernel: no query runtime is configured, so nothing can fetch'));
  },
  invalidateQueries: () => warnUnconfigured('a partition invalidation'),
  removeQueries: () => warnUnconfigured('a store forget'),
};

/**
 * A query runtime that fetches nothing; the default until the app configures one. Its hooks still run, so stores
 * render and read their rows without breaking the rules of hooks.
 */
export const INERT_QUERY: QueryRuntime = {
  client: () => INERT_CLIENT,
  useQuery: () => {
    warnUnconfigured('a partition prime');
    return IDLE;
  },
  useQueries: () => {
    warnUnconfigured('a multi-partition prime');
    return NO_STATUSES;
  },
};

const NO_UNSUBSCRIBE = () => {};

/**
 * Always live, which is the safe default: a host that configures no gate keeps every read taking writes, exactly as
 * it behaved before reads were gated at all. Frozen and shared so it satisfies the stable-reference contract.
 */
const ALWAYS_LIVE: ReadGate = Object.freeze({
  isLive: () => true,
  onChange: () => NO_UNSUBSCRIBE,
});

/** A gate runtime whose reads are always live; the default until the app configures one. */
export const INERT_GATE: ReadGateRuntime = {
  useReadGate: () => ALWAYS_LIVE,
};

let runtime: DataKernelRuntime = { errors: INERT_ERRORS, query: INERT_QUERY, gate: INERT_GATE };

/**
 * Sets the services the kernel uses. Each part passed replaces the current one and the rest are kept, so the app can
 * configure them from different places, and a test can set one and leave the others as defaults.
 */
export function configureDataKernel(next: Partial<DataKernelRuntime>): void {
  runtime = {
    errors: next.errors ?? runtime.errors,
    query: next.query ?? runtime.query,
    gate: next.gate ?? runtime.gate,
  };
}

/** The configured error sink. */
export function errorSink(): ErrorSink {
  return runtime.errors;
}

/** The configured query runtime. */
export function queryRuntime(): QueryRuntime {
  return runtime.query;
}

/** The configured read gate runtime. */
export function readGateRuntime(): ReadGateRuntime {
  return runtime.gate;
}
