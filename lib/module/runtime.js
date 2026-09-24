"use strict";

/**
 * The three services the app provides to the kernel: where error reports go, the React Query runtime fetches run on,
 * and when a read is live. The app calls {@link configureDataKernel} once at startup, before binding any store. Until
 * then each does nothing, so stores still read their rows and tests still render.
 */

import { createOnceGuard } from "./diagnostics/once_guard.js";

/** The extra context sent with a kernel error report, in Sentry's shape. */

/**
 * Where the kernel sends error reports. Shaped like Sentry's two capture calls, so the app can pass Sentry's directly.
 */

/** A React Query key built by the kernel: the store's query root, then the partition's key parts. */

/** One partition's fetch, as the kernel passes it to the app's `useQuery`. The fields are React Query's. */

/** The fields of a `useQuery` result the kernel reads. */

/** The parts of React Query's `QueryClient` the kernel uses for `prefetch`, `invalidate`, `refetch` and `forget`. */

/**
 * The React Query runtime store fetches run on. The app passes its own hooks, which can add policy such as pausing on
 * blur.
 */

/**
 * Tells reads whether they are live, meaning they take writes and update. A read that isn't live keeps its last value
 * until it is live again. The app decides what makes a read not live, such as its screen being blurred.
 *
 * It is a getter and a listener rather than a hook's return value, because it controls whether a read subscribes to
 * writes, not whether it renders. If a change in it re-rendered reads, every screen in the stack would re-render on
 * each navigation.
 */

/** The app's policy for when reads are live. */

/** The services the app provides to the kernel. */

const unconfigured = createOnceGuard();
function warnUnconfigured(what) {
  if (!__DEV__ || unconfigured.seen(what)) return;
  // eslint-disable-next-line no-console
  console.warn(`data_kernel.unconfigured: ${what} was used before \`configureDataKernel\` ran. Reads still answer from the rows ` + 'already stored, but nothing fetches. Call `configureDataKernel` during startup, before binding a store.');
}

/** An error sink that drops every report; the default until the app configures one. */
export const INERT_ERRORS = {
  captureException: () => {},
  captureMessage: () => {}
};
const IDLE = Object.freeze({
  isInitialLoading: false,
  isFetching: false,
  isError: false
});
const NO_STATUSES = Object.freeze([]);
const INERT_CLIENT = {
  fetchQuery: () => {
    warnUnconfigured('a partition prefetch');
    return Promise.reject(new Error('data_kernel: no query runtime is configured, so nothing can fetch'));
  },
  invalidateQueries: () => warnUnconfigured('a partition invalidation'),
  removeQueries: () => warnUnconfigured('a store forget')
};

/**
 * A query runtime that fetches nothing; the default until the app configures one. Its hooks still run, so stores
 * render and read their rows without breaking the rules of hooks.
 */
export const INERT_QUERY = {
  client: () => INERT_CLIENT,
  useQuery: () => {
    warnUnconfigured('a partition prime');
    return IDLE;
  },
  useQueries: () => {
    warnUnconfigured('a multi-partition prime');
    return NO_STATUSES;
  }
};
const NO_UNSUBSCRIBE = () => {};

/**
 * Always live, which is the safe default: a host that configures no gate keeps every read taking writes, exactly as
 * it behaved before reads were gated at all. Frozen and shared so it satisfies the stable-reference contract.
 */
const ALWAYS_LIVE = Object.freeze({
  isLive: () => true,
  onChange: () => NO_UNSUBSCRIBE
});

/** A gate runtime whose reads are always live; the default until the app configures one. */
export const INERT_GATE = {
  useReadGate: () => ALWAYS_LIVE
};
let runtime = {
  errors: INERT_ERRORS,
  query: INERT_QUERY,
  gate: INERT_GATE
};

/**
 * Sets the services the kernel uses. Each part passed replaces the current one and the rest are kept, so the app can
 * configure them from different places, and a test can set one and leave the others as defaults.
 */
export function configureDataKernel(next) {
  runtime = {
    errors: next.errors ?? runtime.errors,
    query: next.query ?? runtime.query,
    gate: next.gate ?? runtime.gate
  };
}

/** The configured error sink. */
export function errorSink() {
  return runtime.errors;
}

/** The configured query runtime. */
export function queryRuntime() {
  return runtime.query;
}

/** The configured read gate runtime. */
export function readGateRuntime() {
  return runtime.gate;
}
//# sourceMappingURL=runtime.js.map