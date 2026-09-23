"use strict";

/**
 * Off-heap dependency tracking: `version.get` reports each partition it reads to the active scope. INVARIANT: an
 * imperative getter must call it on every call, cache hits included, or its tracked consumer is silently stale.
 */

import { GROUP_SEP, KEY_SEP, partitionLabel } from "../args_key.js";
import { createOnceGuard } from "../diagnostics/once_guard.js";
import { renderPhaseOwnerStack } from "./render_phase.js";

/**
 * One partition a tracked read touched, carrying what a consumer needs to watch it: an id to compare against the
 * partitions it watched last time, a subscription, and the version, so a bump between the read and the subscribe is
 * caught rather than missed.
 */

const sinkStack = [];
let subscribedDepth = 0;

/** Marks reads inside `fn` as covered by an explicit subscription, exempting them from the render guard. */
export function runSubscribed(fn) {
  subscribedDepth += 1;
  try {
    return fn();
  } finally {
    subscribedDepth -= 1;
  }
}

/**
 * Reports a partition to whatever scope is tracking, which is how `version.get` makes a read visible to
 * {@link runTracked}. With no scope above it, this is the DEV guard instead: a read during render that nothing has
 * subscribed warns, naming the partition and the component.
 */
export function trackDependency(dep) {
  const sink = sinkStack[sinkStack.length - 1];
  if (sink) {
    if (!sink.has(dep.id)) sink.set(dep.id, dep);
    return;
  }
  if (__DEV__ && subscribedDepth === 0) warnIfUnsubscribedRenderRead(dep);
}
const warnedSites = createOnceGuard();
function warnIfUnsubscribedRenderRead(dep) {
  const ownerStack = renderPhaseOwnerStack();
  if (ownerStack === null) return;
  // Named by partition: a unit or presence descriptor extends its partition's id, and one read reporting several of
  // them is still one unsubscribed read.
  const [partitionId] = dep.id.split(GROUP_SEP);
  if (warnedSites.seen(`${partitionId}${ownerStack}`)) return;
  // eslint-disable-next-line no-console
  console.warn(`[off-heap] read ${partitionLabel(partitionId.split(KEY_SEP))} during render without subscribing to it, so this ` + `component will show the value it read now and never update it. Read through the store's \`useValue\` hook ` + `(it subscribes itself), or run the derivation inside \`useTrackedStores\` / wrap a \`connect\` component ` + `in \`withTrackedStores\`, which subscribe to whatever partitions the read touched. If you subscribed this ` + `partition by hand (a version hook folded into a memo key), say so with \`runSubscribed(() => …)\`.${ownerStack}`);
}
/**
 * Runs `fn` and hands back its value together with the partitions it read, for a consumer that subscribes to them
 * itself — `useTrackedStores` and `createTrackedSelector`. Scopes nest, and an inner one keeps its deps to itself, so a
 * scope inside another forwards them outward with `trackDependency` if it wants the outer one subscribed too.
 */
export function runTracked(fn) {
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
export function isTracking() {
  return sinkStack.length > 0;
}
//# sourceMappingURL=tracking.js.map