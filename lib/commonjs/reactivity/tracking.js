"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.isTracking = isTracking;
exports.runSubscribed = runSubscribed;
exports.runTracked = runTracked;
exports.trackDependency = trackDependency;
var _args_key = require("../args_key.js");
var _once_guard = require("../diagnostics/once_guard.js");
var _render_phase = require("./render_phase.js");
/**
 * Dependency tracking: each version read (`version.get` and the like) reports what it read to the enclosing tracking
 * scope, which subscribes to it. A getter must do this on every call, cache hits included, or a derivation using it
 * won't update.
 */

/** Something a tracked read depended on: a partition, one unit of it, or its presence. */

const sinkStack = [];
let subscribedDepth = 0;

/**
 * Runs `fn`, marking its reads as already subscribed to by hand, which silences the dev warning about reading during
 * render without subscribing.
 */
function runSubscribed(fn) {
  subscribedDepth += 1;
  try {
    return fn();
  } finally {
    subscribedDepth -= 1;
  }
}

/**
 * Reports a dependency to the enclosing tracking scope; this is how `version.get` makes a read visible to
 * {@link runTracked}. Outside any scope, in dev, a read during render that nothing subscribes to logs a warning naming
 * the partition and the component.
 */
function trackDependency(dep) {
  const sink = sinkStack[sinkStack.length - 1];
  if (sink) {
    if (!sink.has(dep.id)) sink.set(dep.id, dep);
    return;
  }
  if (__DEV__ && subscribedDepth === 0) warnIfUnsubscribedRenderRead(dep);
}
const warnedSites = (0, _once_guard.createOnceGuard)();
function warnIfUnsubscribedRenderRead(dep) {
  const ownerStack = (0, _render_phase.renderPhaseOwnerStack)();
  if (ownerStack === null) return;
  // Named by partition: a unit or presence descriptor extends its partition's id, and one read reporting several of
  // them is still one unsubscribed read.
  const [partitionId] = dep.id.split(_args_key.GROUP_SEP);
  if (warnedSites.seen(`${partitionId}${ownerStack}`)) return;
  // eslint-disable-next-line no-console
  console.warn(`[off-heap] read ${(0, _args_key.partitionLabel)(partitionId.split(_args_key.KEY_SEP))} during render without subscribing to it, so this ` + `component will show the value it read now and never update it. Read through the store's \`useValue\` hook ` + `(it subscribes itself), or run the derivation inside \`useTrackedStores\` / wrap a \`connect\` component ` + `in \`withTrackedStores\`, which subscribe to whatever partitions the read touched. If you subscribed this ` + `partition by hand (a version hook folded into a memo key), say so with \`runSubscribed(() => …)\`.${ownerStack}`);
}
/**
 * Runs `fn` in a tracking scope, returning its value and what it read, for a caller that subscribes to those itself,
 * such as `useTrackedStores`. An inner scope doesn't pass its dependencies to the outer one; call `trackDependency` on
 * each to forward them.
 */
function runTracked(fn) {
  const sink = new Map();
  sinkStack.push(sink);
  try {
    const value = fn();
    return {
      value,
      deps: Array.from(sink.values())
    };
  } finally {
    sinkStack.pop();
  }
}

/**
 * Whether a scope is collecting dependencies right now, for deciding whether a warning is warranted: deps collected
 * with nothing above them reach no subscriber. Not for branching real behaviour on — a read reports itself either way.
 */
function isTracking() {
  return sinkStack.length > 0;
}
//# sourceMappingURL=tracking.js.map