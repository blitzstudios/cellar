"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useTrackedValue = useTrackedValue;
var _react = require("react");
var _withSelector = require("use-sync-external-store/shim/with-selector");
var _runtime = require("../runtime.js");
var _tracking = require("./tracking.js");
/**
 * The hook every reactive read goes through: run a derivation, subscribe to exactly what it read, and run it again
 * when one of those things changes.
 *
 * What a derivation depends on is found by running it, not declared: every version it reads reports itself to the
 * tracking scope this opens — a unit it named, a partition it scanned, a partition's presence — and those are what the
 * component subscribes to. A read of three players subscribes to three players, and a write that changed a fourth
 * leaves it asleep. When the derivation reads something different next time, the subscriptions follow.
 */

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
function useTrackedValue(compute, inputs, options) {
  const {
    enabled,
    isEqual,
    empty,
    subscribeExtra
  } = options;
  const gate = (0, _runtime.readGateRuntime)().useReadGate();
  const [inst] = (0, _react.useState)(createInstance);
  const subscribe = (0, _react.useCallback)(onChange => {
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
  const getSnapshot = (0, _react.useCallback)(() => inst.epoch, [inst]);
  const selector = (0, _react.useCallback)(() => {
    if (!enabled) return {
      value: empty,
      deps: NO_DEPS,
      versions: NO_VERSIONS
    };
    const {
      value,
      deps
    } = (0, _tracking.runTracked)(compute);
    return {
      value,
      deps,
      versions: deps.map(dep => dep.getVersion())
    };
  },
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `inputs` is what `compute` closes over; `empty` is stable per call site
  [enabled, ...inputs]);

  // Comparing values alone would bail the render and leave the hook subscribed to what `compute` stopped reading.
  const selectionEqual = (0, _react.useCallback)((left, right) => sameDeps(left.deps, right.deps) && isEqual(left.value, right.value), [isEqual]);
  const tracked = (0, _withSelector.useSyncExternalStoreWithSelector)(subscribe, getSnapshot, getSnapshot, selector, selectionEqual);
  (0, _react.useEffect)(() => {
    inst.last = tracked;
    if (!inst.live) return;
    subscribeTo(inst, tracked.deps);
    // Catches a write that landed between the derivation running and this effect subscribing to what it read.
    if (moved(tracked)) inst.notify();
  });
  (0, _react.useEffect)(() => () => unsubscribeAll(inst), [inst]);
  return tracked.value;
}
//# sourceMappingURL=tracked_value.js.map