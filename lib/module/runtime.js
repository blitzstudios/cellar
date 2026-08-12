"use strict";

/**
 * The two services the kernel takes from its host rather than owning: where a report goes, and the React Query
 * runtime an ingest mounts on. A host calls {@link configureDataKernel} once during startup, before it binds any
 * store's backend. Until it does, both stay inert, so a store still reads its rows and a test still renders.
 */

import { createOnceGuard } from "./diagnostics/once_guard.js";

/** The Sentry-shaped context a kernel report carries. */

/** Where a kernel report goes, shaped like the two Sentry calls it stands in for so a host wires it in one line. */

/** A query key as the kernel builds it: the ingest root, then the partition's parts. */

/** One partition's conditional fetch as the kernel hands it over, for the host to gate and mount. */

/** The three fields a prime reports to the read that mounted it. */

/** The imperative half of the runtime, behind `prefetch`, `invalidate`, `refetch` and `forget`. */

/**
 * The query runtime a store's fetch side runs on. `useQuery` and `useQueries` are hooks, so a host passes its own
 * focus-gated drop-ins and keeps that policy. `client` is read per call, letting a host install it after this.
 */

/** Everything a host supplies. Either half may be configured on its own. */

const unconfigured = createOnceGuard();
function warnUnconfigured(what) {
  if (!__DEV__ || unconfigured.seen(what)) return;
  // eslint-disable-next-line no-console
  console.warn(`data_kernel.unconfigured: ${what} was used before \`configureDataKernel\` ran. Reads still answer from the rows ` + 'already stored, but nothing fetches. Call `configureDataKernel` during startup, before binding a backend.');
}

/** Drops every report. The default until a host configures one. */
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
 * Holds each hook's position in the render and stays idle, so a store whose host never configured a runtime renders
 * and reads instead of breaking the rules of hooks.
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
let runtime = {
  errors: INERT_ERRORS,
  query: INERT_QUERY
};

/**
 * Installs a host's services. Each half given replaces the one before it, so a test can hand back {@link INERT_ERRORS}
 * or {@link INERT_QUERY} to take one away again.
 */
export function configureDataKernel(next) {
  runtime = {
    errors: next.errors ?? runtime.errors,
    query: next.query ?? runtime.query
  };
}
export function errorSink() {
  return runtime.errors;
}
export function queryRuntime() {
  return runtime.query;
}
//# sourceMappingURL=runtime.js.map