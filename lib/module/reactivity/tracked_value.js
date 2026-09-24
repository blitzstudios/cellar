"use strict";

/**
 * The hook behind every reactive read: it runs a derivation, subscribes to exactly what it read, and runs it again
 * when one of those changes.
 *
 * Dependencies are found by running the derivation, not declared: each unit, partition or presence it reads is
 * subscribed to. A read of three players subscribes to those three, so a write to a fourth doesn't re-run it. When the
 * derivation reads something different next time, the subscriptions change to match.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector';
import { readGateRuntime } from "../runtime.js";
import { runTracked } from "./tracking.js";

/** Options for {@link useTrackedValue}. */

const NOOP = () => {};
const NO_DEPS = Object.freeze([]);
const NO_VERSIONS = Object.freeze([]);
const createInstance = () => ({
  epoch: 0,
  notify: NOOP,
  subscribed: new Map(),
  last: null,
  live: true
});
const sameDeps = (left, right) => left.length === right.length && left.every((dep, index) => dep.id === right[index].id);
const moved = tracked => tracked.deps.some((dep, index) => dep.getVersion() !== tracked.versions[index]);
function unsubscribeAll(inst) {
  for (const unsub of inst.subscribed.values()) unsub();
  inst.subscribed.clear();
}

/** Brings the subscriptions in line with what the last derivation read, dropping what it no longer reads. */
function subscribeTo(inst, deps) {
  const next = new Map(deps.map(dep => [dep.id, dep]));
  for (const [id, unsub] of inst.subscribed) {
    if (!next.has(id)) {
      unsub();
      inst.subscribed.delete(id);
    }
  }
  for (const [id, dep] of next) if (!inst.subscribed.has(id)) inst.subscribed.set(id, dep.subscribe(() => inst.notify()));
}

/**
 * Runs `compute`, subscribes to what it read, and re-renders with a new value when any of that changes. `inputs` are
 * the values `compute` uses, such as the read's args; a change in them also re-runs it.
 *
 * While the component's read gate isn't live, it unsubscribes and keeps its last value, so a hidden screen doesn't
 * re-render. When the gate is live again, it re-renders once if anything changed meanwhile.
 */
export function useTrackedValue(compute, inputs, options) {
  const {
    enabled,
    isEqual,
    empty,
    subscribeExtra
  } = options;
  const gate = readGateRuntime().useReadGate();
  const [inst] = useState(createInstance);
  const subscribe = useCallback(onChange => {
    inst.notify = () => {
      inst.epoch += 1;
      onChange();
    };
    const offExtra = subscribeExtra?.(inst.notify);
    const syncGate = () => {
      const live = gate.isLive();
      if (live === inst.live) return;
      inst.live = live;
      if (!live) {
        // Held at what the last derivation saw, so a write landing now cannot move what the screen shows.
        unsubscribeAll(inst);
        return;
      }
      if (inst.last) {
        subscribeTo(inst, inst.last.deps);
        if (moved(inst.last)) inst.notify();
      }
    };
    inst.live = gate.isLive();
    const offGate = gate.onChange(syncGate);
    return () => {
      offExtra?.();
      offGate();
      inst.notify = NOOP;
    };
  }, [inst, gate, subscribeExtra]);
  const getSnapshot = useCallback(() => inst.epoch, [inst]);
  const selector = useCallback(() => {
    if (!enabled) return {
      value: empty,
      deps: NO_DEPS,
      versions: NO_VERSIONS
    };
    const {
      value,
      deps
    } = runTracked(compute);
    return {
      value,
      deps,
      versions: deps.map(dep => dep.getVersion())
    };
  },
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `inputs` is what `compute` closes over; `empty` is stable per call site
  [enabled, ...inputs]);

  // Comparing values alone would bail the render and leave the hook subscribed to what `compute` stopped reading.
  const selectionEqual = useCallback((left, right) => sameDeps(left.deps, right.deps) && isEqual(left.value, right.value), [isEqual]);
  const tracked = useSyncExternalStoreWithSelector(subscribe, getSnapshot, getSnapshot, selector, selectionEqual);
  useEffect(() => {
    inst.last = tracked;
    if (!inst.live) return;
    subscribeTo(inst, tracked.deps);
    // Catches a write that landed between the derivation running and this effect subscribing to what it read.
    if (moved(tracked)) inst.notify();
  });
  useEffect(() => () => unsubscribeAll(inst), [inst]);
  return tracked.value;
}
//# sourceMappingURL=tracked_value.js.map