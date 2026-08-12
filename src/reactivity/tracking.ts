/**
 * Off-heap dependency tracking: `version.get` reports each partition it reads to the active scope. INVARIANT: an
 * imperative getter must call it on every call, cache hits included, or its tracked consumer is silently stale.
 */

import { KEY_SEP, partitionLabel } from '../args_key';
import { createOnceGuard } from '../diagnostics/once_guard';
import { renderPhaseOwnerStack } from './render_phase';

/**
 * One partition a tracked read touched, carrying what a consumer needs to watch it: an id to compare against the
 * partitions it watched last time, a subscription, and the version, so a bump between the read and the subscribe is
 * caught rather than missed.
 */
export interface Dep {
  id: string;
  subscribe: (listener: () => void) => () => void;
  getVersion: () => number;
}

const sinkStack: Map<string, Dep>[] = [];

let subscribedDepth = 0;

/** Marks reads inside `fn` as covered by an explicit subscription, exempting them from the render guard. */
export function runSubscribed<T>(fn: () => T): T {
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
export function trackDependency(dep: Dep): void {
  const sink = sinkStack[sinkStack.length - 1];
  if (sink) {
    if (!sink.has(dep.id)) sink.set(dep.id, dep);
    return;
  }
  if (__DEV__ && subscribedDepth === 0) warnIfUnsubscribedRenderRead(dep);
}

const warnedSites = createOnceGuard();

function warnIfUnsubscribedRenderRead(dep: Dep): void {
  const ownerStack = renderPhaseOwnerStack();
  if (ownerStack === null) return;
  if (warnedSites.seen(`${dep.id}${ownerStack}`)) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[off-heap] read ${partitionLabel(dep.id.split(KEY_SEP))} during render without subscribing to it, so this ` +
      `component will show the value it read now and never update it. Read through the store's \`useValue\` hook ` +
      `(it subscribes itself), or run the derivation inside \`useTrackedStores\` / wrap a \`connect\` component ` +
      `in \`withTrackedStores\`, which subscribe to whatever partitions the read touched. If you subscribed this ` +
      `partition by hand (a version hook folded into a memo key), say so with \`runSubscribed(() => …)\`.${ownerStack}`,
  );
}
/**
 * Runs `fn` and hands back its value together with the partitions it read, for a consumer that subscribes to them
 * itself — `useTrackedStores` and `createTrackedSelector`. Scopes nest, and an inner one keeps its deps to itself, so a
 * scope inside another forwards them outward with `trackDependency` if it wants the outer one subscribed too.
 */
export function runTracked<T>(fn: () => T): { value: T; deps: Dep[] } {
  const sink = new Map<string, Dep>();
  sinkStack.push(sink);
  try {
    const value = fn();
    return { value, deps: Array.from(sink.values()) };
  } finally {
    sinkStack.pop();
  }
}

/**
 * Whether a scope is collecting dependencies right now, for deciding whether a warning is warranted: deps collected
 * with nothing above them reach no subscriber. Not for branching real behaviour on — a read reports itself either way.
 */
export function isTracking(): boolean {
  return sinkStack.length > 0;
}
