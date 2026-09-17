"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.INERT_QUERY = exports.INERT_GATE = exports.INERT_ERRORS = void 0;
exports.configureDataKernel = configureDataKernel;
exports.errorSink = errorSink;
exports.queryRuntime = queryRuntime;
exports.readGateRuntime = readGateRuntime;
var _once_guard = require("./diagnostics/once_guard.js");
/**
 * The three services the kernel takes from its host rather than owning: where a report goes, the React Query
 * runtime an ingest mounts on, and when a read is live. A host calls
 * {@link configureDataKernel} once during startup, before it binds any store's backend. Until it does, each stays
 * inert, so a store still reads its rows and a test still renders.
 */

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

/**
 * Whether a read should still be taking writes, and how to hear about that changing.
 *
 * The kernel never learns why a gate went dead — a blurred screen, a hidden subtree, a backgrounded app are all the
 * same boolean to it, and the host owns which of those count. It is deliberately not a boolean returned from a hook
 * either: this gates a read's *subscription*, not its render. A read that re-rendered when the gate moved would wake
 * every screen in the stack on each navigation, which is the cost being avoided.
 */

/**
 * The host's policy for when a read is live. `useReadGate` is a hook so it can read the enclosing subtree's owner
 * from context.
 *
 * It MUST return a reference-stable gate for as long as that owner is the same one — the kernel keys its
 * subscription on the gate's identity, so one rebuilt each render would resubscribe each render.
 */

/** Everything a host supplies. Each part may be configured on its own. */

const unconfigured = (0, _once_guard.createOnceGuard)();
function warnUnconfigured(what) {
  if (!__DEV__ || unconfigured.seen(what)) return;
  // eslint-disable-next-line no-console
  console.warn(`data_kernel.unconfigured: ${what} was used before \`configureDataKernel\` ran. Reads still answer from the rows ` + 'already stored, but nothing fetches. Call `configureDataKernel` during startup, before binding a backend.');
}

/** Drops every report. The default until a host configures one. */
const INERT_ERRORS = exports.INERT_ERRORS = {
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
const INERT_QUERY = exports.INERT_QUERY = {
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
const INERT_GATE = exports.INERT_GATE = {
  useReadGate: () => ALWAYS_LIVE
};
let runtime = {
  errors: INERT_ERRORS,
  query: INERT_QUERY,
  gate: INERT_GATE
};

/**
 * Installs a host's services. Each part given replaces the one before it, so a host may configure error reporting,
 * the query runtime and the read gate from different places, and a test may install one and leave the rest inert.
 */
function configureDataKernel(next) {
  runtime = {
    errors: next.errors ?? runtime.errors,
    query: next.query ?? runtime.query,
    gate: next.gate ?? runtime.gate
  };
}
function errorSink() {
  return runtime.errors;
}
function queryRuntime() {
  return runtime.query;
}
function readGateRuntime() {
  return runtime.gate;
}
//# sourceMappingURL=runtime.js.map