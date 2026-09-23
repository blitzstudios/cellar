"use strict";

/**
 * The hook every reactive read goes through: run a derivation, subscribe to exactly what it read, and run it again
 * when one of those things changes.
 *
 * What a derivation depends on is found by running it, not declared: every version it reads reports itself to the
 * tracking scope this opens — a unit it named, a partition it scanned, a partition's presence — and those are what the
 * component subscribes to. A read of three players subscribes to three players, and a write that changed a fourth
 * leaves it asleep. When the derivation reads something different next time, the subscriptions follow.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector';
import { readGateRuntime } from "../runtime.js";
import { runTracked } from "./tracking.js";
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
 * Runs `compute` and subscribes to what it read. `inputs` is what `compute` closes over — the read's args — and a
 * change in them runs it again whether or not anything it read moved.
 *
 * The host's read gate applies: while it is closed the subscriptions are dropped and the value is held, so a screen
 * nobody is looking at does not repaint, and when it reopens one render catches up — only if something moved.
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