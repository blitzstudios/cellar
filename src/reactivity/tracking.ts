/**
 * Dependency tracking: each version read (`version.get` and the like) reports what it read to the enclosing tracking
 * scope, which subscribes to it. A getter must do this on every call, cache hits included, or a derivation using it
 * won't update.
 */

import { GROUP_SEP, KEY_SEP, partitionLabel } from '../args_key';
import { createOnceGuard } from '../diagnostics/once_guard';
import { renderPhaseOwnerStack } from './render_phase';

/** Something a tracked read depended on: a partition, one unit of it, or its presence. */
export interface Dep {
  /** Identifies the dependency, so a scope can compare what it read against what it subscribed to last time. */
  id: string;
  /** Calls `listener` when it changes, returning an unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Its current version, for noticing a change between the read and the subscribe. */
  getVersion: () => number;
}

const sinkStack: Map<string, Dep>[] = [];

let subscribedDepth = 0;

/**
 * Runs `fn`, marking its reads as already subscribed to by hand, which silences the dev warning about reading during
 * render without subscribing.
 */
export function runSubscribed<T>(fn: () => T): T {
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
  // Named by partition: a unit or presence descriptor extends its partition's id, and one read reporting several of
  // them is still one unsubscribed read.
  const [partitionId] = dep.id.split(GROUP_SEP);
  if (warnedSites.seen(`${partitionId}${ownerStack}`)) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[off-heap] read ${partitionLabel(partitionId.split(KEY_SEP))} during render without subscribing to it, so this ` +
      `component will show the value it read now and never update it. Read through the store's \`useValue\` hook ` +
      `(it subscribes itself), or run the derivation inside \`useTrackedStores\` / wrap a \`connect\` component ` +
      `in \`withTrackedStores\`, which subscribe to whatever partitions the read touched. If you subscribed this ` +
      `partition by hand (a version hook folded into a memo key), say so with \`runSubscribed(() => …)\`.${ownerStack}`,
  );
}
/**
 * Runs `fn` in a tracking scope, returning its value and what it read, for a caller that subscribes to those itself,
 * such as `useTrackedStores`. An inner scope doesn't pass its dependencies to the outer one; call `trackDependency` on
 * each to forward them.
 */
export function runTracked<T>(fn: () => T): {
  /** What `fn` returned. */
  value: T;
  /** What `fn` read. */
  deps: Dep[];
} {
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
