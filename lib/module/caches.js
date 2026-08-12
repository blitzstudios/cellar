"use strict";

/**
 * Bounded caches for values derived from off-heap rows. A version key answers without a query but misses on every
 * write to the partition; a source key survives that miss and keeps the reference when the rows behind it are
 * unchanged. {@link createVersionedSourceCache} carries both, which is what a value feeding an identity comparison
 * downstream wants. A store reaches these through {@link declareMemos}, which is where it accounts for all of them
 * at once.
 */

import { reportStoreDegradation } from "./diagnostics/telemetry.js";
const EVICTION_GHOSTS = 256;
const UNDERSIZED_REPORT_AT = 256;
const NEVER_HIT_REPORT_AT = 512;

/** What a declared memo calls itself in a report, and what its keys are built from. */

/**
 * The watch a declared memo carries in dev. It reports one too small for its working set — a key evicted for capacity,
 * then asked for again — and one that has never once answered from its entry, which is heap held for nothing.
 */
function createMemoWatch({
  name,
  keyedBy
}, maxEntries) {
  const ghosts = new Set();
  let returned = 0;
  let missed = 0;
  let earned = false;
  return {
    onEvict: key => {
      ghosts.add(key);
      if (ghosts.size > EVICTION_GHOSTS) ghosts.delete(ghosts.values().next().value);
    },
    /** Call on a lookup that answered from the entry, which is how a memo shows it is earning its heap. */
    noteHit: () => {
      earned = true;
    },
    /** Call on a lookup that did not; `absent` separates an evicted key from an entry held at another version. */
    noteMiss: (key, absent) => {
      if (!earned) {
        missed += 1;
        if (missed === NEVER_HIT_REPORT_AT) reportStoreDegradation({
          scope: `memo.never_hit.${name}`,
          context: `${NEVER_HIT_REPORT_AT} lookups keyed by ${keyedBy} never answered from the entry, so whatever calls this already holds the value`,
          extra: {
            maxEntries
          }
        });
      }
      if (!absent || !ghosts.delete(key)) return;
      returned += 1;
      if (returned !== UNDERSIZED_REPORT_AT) return;
      reportStoreDegradation({
        scope: `memo.undersized.${name}`,
        context: `${UNDERSIZED_REPORT_AT} keys evicted for capacity were read again, so values keyed by ${keyedBy} are being rebuilt and their readers repainted`,
        extra: {
          maxEntries
        }
      });
    }
  };
}

/**
 * A fixed-capacity string-keyed map that drops its coldest entry when full: what every cache in this file is built on,
 * and what a store reaches for to bound a table it keys itself — interned partition records, per-partition timestamps.
 */

/** Builds one holding at most `max` entries. `onEvict` fires for a key dropped for capacity, which is how a cache notices it is undersized. */
export function createBoundedLru(max, onEvict) {
  const map = new Map();
  return {
    keys: () => map.keys(),
    get(key) {
      // `V` may itself be `undefined`, so membership needs `has`; a value test pins such an entry at the cold end.
      if (!map.has(key)) return undefined;
      const hit = map.get(key);
      map.delete(key);
      map.set(key, hit);
      return hit;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      if (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined && oldest !== key) {
          map.delete(oldest);
          onEvict?.(oldest);
        }
      }
    }
  };
}

/**
 * A memo over values derived from a partition's rows, held against that partition's version, so a read no write
 * invalidated answers from the entry instead of querying the table again. An `isEqual` on top hands back the prior
 * reference when a recompute turned out to change nothing, so a downstream shallow-equal bails and nothing repaints.
 */

/** Builds one. Stores declare theirs through {@link declareMemos}; the read surface holds its own two directly. */
export function createVersionedCache(maxEntries, isEqual, diagnostics) {
  const watch = __DEV__ && diagnostics ? createMemoWatch(diagnostics, maxEntries) : undefined;
  const lru = createBoundedLru(maxEntries, watch?.onEvict);
  const cache = {
    read(key, version, compute) {
      const hit = cache.peek(key, version);
      return hit ? hit.value : cache.set(key, version, compute());
    },
    peek(key, version) {
      const hit = lru.get(key);
      const found = hit && hit.version === version ? hit : undefined;
      if (watch) {
        if (found) watch.noteHit();else watch.noteMiss(key, !hit);
      }
      return found;
    },
    set(key, version, value) {
      // Read by key alone: reference reuse has to survive the bump that triggered the recompute.
      const prior = lru.get(key);
      const stored = prior && isEqual && isEqual(prior.value, value) ? prior.value : value;
      lru.set(key, {
        version,
        value: stored
      });
      return stored;
    }
  };
  return cache;
}

/**
 * A value held against both its partition's version and its own source: the version answers without touching the
 * table at all, and the source keeps the reference when a bump turns out not to have changed these particular rows.
 */

/** `source` is compared with `Object.is`, so it must be a primitive or already reference-stable. */
export function createVersionedSourceCache(maxEntries, diagnostics) {
  const watch = __DEV__ ? createMemoWatch(diagnostics, maxEntries) : undefined;
  const lru = createBoundedLru(maxEntries, watch?.onEvict);
  return {
    peek(key, version) {
      const hit = lru.get(key);
      const found = hit && hit.version === version ? hit : undefined;
      if (found) watch?.noteHit();
      return found;
    },
    put(key, version, source, build) {
      const hit = lru.get(key);
      const reused = hit && Object.is(hit.source, source);
      if (watch) {
        if (reused) watch.noteHit();else watch.noteMiss(key, !hit);
      }
      const value = reused ? hit.value : build();
      lru.set(key, {
        version,
        source,
        value
      });
      return value;
    }
  };
}

/** A memo declared in a {@link declareMemos} block. {@link byVersion} and {@link bySource} are the two that exist. */

/**
 * A memo dropped by every write to its partition. Reach for it when several reads derive the same value from a
 * partition's rows, or when one read consults it once per item: a memo keyed the way a single read is keyed holds
 * only what that read's own memo already holds.
 */
export function byVersion(spec) {
  return {
    keyedBy: spec.keyedBy,
    build: diagnostics => createVersionedCache(spec.max, spec.isEqual, diagnostics)
  };
}

/**
 * A memo that outlives the write a version-keyed one is dropped by, because it compares the rows behind the value.
 * Reach for it when the value feeds an identity comparison downstream and a bump elsewhere in the partition should
 * not repaint its readers.
 */
export function bySource(spec) {
  return {
    keyedBy: spec.keyedBy,
    build: diagnostics => createVersionedSourceCache(spec.max, diagnostics)
  };
}

/**
 * Every memo a store holds, declared in one block: what each keeps, how many of them, and what a key is built from.
 * This is the only way a store builds one, so the block is a complete account of what it derives onto the heap.
 */
export function declareMemos(store, decls) {
  const out = {};
  for (const memo of Object.keys(decls)) {
    out[memo] = decls[memo].build({
      name: `${store}.${memo}`,
      keyedBy: decls[memo].keyedBy
    });
  }
  return out;
}

/**
 * The `isEqual` for a read handing back a record of reference-stable values, which a hydration's map of VMs by id is:
 * a rebuilt map whose entries are the same references is not a change, so its readers do not repaint.
 */
export function shallowEqualRecord(left, right) {
  if (left === right) return true;
  const aKeys = Object.keys(left);
  if (aKeys.length !== Object.keys(right).length) return false;
  for (const key of aKeys) {
    if (!Object.is(left[key], right[key])) return false;
  }
  return true;
}

/**
 * The `isEqual` for a read handing back a struct: every field compared with `Object.is`, except the ones named in
 * `deep`, which carry their own check. A scalar field added to `T` is covered without touching the call, and one
 * holding a freshly built object reads as a change until it is named here — the safe direction, since the cost of
 * that is a repaint rather than a stale value.
 */
export function shallowEqualStruct(deep) {
  return (left, right) => {
    if (left === right) return true;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const same = deep[key];
      if (same ? !same(left[key], right[key]) : !Object.is(left[key], right[key])) return false;
    }
    return true;
  };
}

/** The same `isEqual` for a read handing back a list: a re-run that produced the same values in the same order is not a change. */
export function shallowEqualArray(left, right) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}
//# sourceMappingURL=caches.js.map