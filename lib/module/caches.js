"use strict";

/**
 * Size-limited caches for values computed from table rows. Each value is kept until what it was computed from changes:
 * its partition, or the one unit it was built from. An `isEqual` keeps the previous object when a rebuild produces an
 * equal value. Stores declare theirs with {@link createMemos}.
 */

import { identityOf, KEY_SEP, cacheKeyOf } from "./args_key.js";
import { reportStoreDegradation } from "./diagnostics/telemetry.js";
import { runTracked, trackDependency } from "./reactivity/tracking.js";
import { covered } from "./table/read_coverage.js";
const EVICTION_GHOSTS = 256;
const UNDERSIZED_REPORT_AT = 256;
const NEVER_HIT_REPORT_AT = 512;

/** How a memo is named in its dev warnings. */

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
 * A map with string keys and a fixed capacity, which drops its least recently used entry when full. Every cache here is
 * built on one, and a store can use one for its own bounded lookups.
 */

/** One entry's place in the recency list: `older` runs toward the coldest end, `newer` toward the hottest. */

/**
 * Creates a {@link BoundedLru} holding at most `max` entries. `onEvict` is called with each key dropped to make room.
 */
export function createBoundedLru(max, onEvict) {
  const map = new Map();
  // Recency rides a linked list rather than `Map` insertion order: reordering by re-inserting
  // allocates a fresh entry on every hit, and hits are the hot path. Relinking mutates nodes.
  let oldest;
  let newest;
  const unlink = node => {
    if (node.older) node.older.newer = node.newer;else oldest = node.newer;
    if (node.newer) node.newer.older = node.older;else newest = node.older;
    node.older = undefined;
    node.newer = undefined;
  };
  const linkNewest = node => {
    node.older = newest;
    if (newest) newest.newer = node;else oldest = node;
    newest = node;
  };
  const touch = node => {
    if (node === newest) return;
    unlink(node);
    linkNewest(node);
  };
  return {
    *keys() {
      for (let node = oldest; node !== undefined; node = node.newer) yield node.key;
    },
    get(key) {
      // A present key always has a node, so a stored `undefined` still reads as a hit.
      const node = map.get(key);
      if (node === undefined) return undefined;
      touch(node);
      return node.value;
    },
    set(key, value) {
      const existing = map.get(key);
      if (existing !== undefined) {
        existing.value = value;
        touch(existing);
        return;
      }
      const node = {
        key,
        value,
        older: undefined,
        newer: undefined
      };
      map.set(key, node);
      linkNewest(node);
      if (map.size > max && oldest !== undefined && oldest !== node) {
        const evicted = oldest;
        unlink(evicted);
        map.delete(evicted.key);
        onEvict?.(evicted.key);
      }
    }
  };
}

/**
 * A cache of values stored with the version they were computed at. A lookup at a different version misses, so a value
 * is recomputed once after each write. An `isEqual` keeps the previous object when the recompute is equal to it.
 */

/** Creates a {@link VersionedCache}. Stores declare theirs through {@link createMemos}. */
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
 * A cache of values kept until anything their computation read changes; this is how reads cache their results. A read
 * of three players keeps its value through a write that changed a fourth. Every lookup, hit or miss, passes the
 * value's dependencies up to the caller's tracking scope, so a cached value is subscribed to like a computed one.
 */

/** Creates a {@link TrackedCache}. `isEqual` keeps the previous object when a recompute produces an equal value. */
export function createTrackedCache(maxEntries, isEqual) {
  const lru = createBoundedLru(maxEntries);
  return {
    read(key, compute) {
      const hit = lru.get(key);
      if (hit && hit.deps.every((dep, index) => dep.getVersion() === hit.versions[index])) {
        for (const dep of hit.deps) trackDependency(dep);
        return hit.value;
      }
      const {
        value,
        deps
      } = runTracked(compute);
      const kept = hit && isEqual && isEqual(hit.value, value) ? hit.value : value;
      lru.set(key, {
        value: kept,
        deps,
        versions: deps.map(dep => dep.getVersion())
      });
      for (const dep of deps) trackDependency(dep);
      return kept;
    }
  };
}

/**
 * One part of a memo's key beyond the partition: a scalar, or an object or array such as a config. Equal objects map to
 * the same short id, so an object costs no more in the key than a scalar.
 */

/** One `MemoPart` per name the memo declared in `by`, in that order. */

/**
 * A {@link byVersion} memo for one partition, as returned by `memo.for(key)`. Its entries are keyed by the parts listed
 * in `by`, and are dropped by any write to the partition.
 */

/**
 * A {@link byUnit} memo for one partition, as returned by `memo.for(key)`. Each entry belongs to one unit and is
 * kept until that unit's rows change. A read that uses it re-renders only when the units it asked for change.
 */

/** A memo declared in a store's `memos` block. */

/**
 * A memo definition, before {@link createMemos} attaches it to a store. {@link byVersion} and {@link byUnit} create
 * them.
 */

/** A memo definition, as created by {@link byVersion} or {@link byUnit}. */

/** What a store's partitions give its memos: each partition's key parts and version. */

const INTERNED_PARTS_MAX = 256;

/**
 * Turns a memo's parts into one key. A structured part is interned rather than spelled out: two lookups passing equal
 * content get the same id, and a memo of thousands of entries holds ids instead of repeated JSON. An id evicted for
 * capacity costs a rebuild, never a wrong answer.
 */
function createPartKeyer() {
  const ids = createBoundedLru(INTERNED_PARTS_MAX);
  let nextId = 0;
  const idFor = part => {
    const identity = identityOf(part);
    const held = ids.get(identity);
    if (held) return held;
    nextId += 1;
    const id = `#${nextId}`;
    ids.set(identity, id);
    return id;
  };
  return (prefix, parts) => {
    if (!parts.length) return prefix;
    let key = prefix;
    for (const part of parts) key += KEY_SEP + (part !== null && typeof part === 'object' ? idFor(part) : String(part ?? ''));
    return key;
  };
}

/** The last argument of a variadic memo call, and the parts before it. */
function splitArgs(args) {
  return {
    parts: args.slice(0, -1),
    last: args[args.length - 1]
  };
}

/**
 * Declares a memo of values computed from a whole partition, dropped by any write to it. Use it for a value several
 * reads share, or one a read looks up per item. A memo keyed exactly like one read adds nothing, since the read
 * already caches its result.
 */
export function byVersion() {
  return spec => ({
    by: spec.by ?? [],
    bind: (store, diagnostics) => {
      const cache = createVersionedCache(spec.max, spec.isEqual, diagnostics);
      const keyer = createPartKeyer();
      return {
        for: key => {
          const prefix = cacheKeyOf(store.parts(key));
          const version = store.version(key);
          return {
            read: (...args) => {
              const {
                parts,
                last
              } = splitArgs(args);
              return cache.read(keyer(prefix, parts), version, last);
            },
            peek: (...parts) => cache.peek(keyer(prefix, parts), version),
            set: (...args) => {
              const {
                parts,
                last
              } = splitArgs(args);
              return cache.set(keyer(prefix, parts), version, last);
            }
          };
        }
      };
    }
  });
}

/**
 * Declares a memo of values built from one unit's rows, such as a player's, each kept until that unit changes. A write
 * to other units leaves the entry and its object alone, and a read using it re-renders only when its own units change.
 * Table reads inside `build` count as reads of that unit, not of the whole partition.
 */
export function byUnit() {
  return spec => ({
    by: spec.by ?? [],
    bind: (store, diagnostics) => {
      const watch = __DEV__ ? createMemoWatch(diagnostics, spec.max) : undefined;
      const lru = createBoundedLru(spec.max, watch?.onEvict);
      const keyer = createPartKeyer();
      /** The entry for this key if it was built at the unit's current version; noted as a hit or a miss. */
      const current = (key, version) => {
        const hit = lru.get(key);
        const found = hit && hit.version === version ? hit : undefined;
        if (watch) {
          if (found) watch.noteHit();else watch.noteMiss(key, !hit);
        }
        return found;
      };
      const store_ = (key, version, value) => {
        const prior = lru.get(key);
        const kept = prior && spec.isEqual && spec.isEqual(prior.value, value) ? prior.value : value;
        lru.set(key, {
          version,
          value: kept
        });
        return kept;
      };
      return {
        for: key => {
          const prefix = cacheKeyOf(store.parts(key));
          const entryKey = (unit, parts) => keyer(`${prefix}${KEY_SEP}${unit}`, parts);
          return {
            read: (unit, ...args) => {
              const {
                parts,
                last: build
              } = splitArgs(args);
              const version = store.unitVersion(key, unit);
              const at = entryKey(unit, parts);
              const hit = current(at, version);
              return hit ? hit.value : store_(at, version, covered(build));
            },
            readMany: (units, ...args) => {
              const {
                parts,
                last: build
              } = splitArgs(args);
              const out = new Map();
              const missing = [];
              for (const unit of units) {
                const version = store.unitVersion(key, unit);
                const at = entryKey(unit, parts);
                const hit = current(at, version);
                if (hit) out.set(unit, hit.value);else missing.push({
                  unit,
                  at,
                  version
                });
              }
              if (!missing.length) return out;
              const built = covered(() => build(missing.map(entry => entry.unit)));
              for (const {
                unit,
                at,
                version
              } of missing) out.set(unit, store_(at, version, built.get(unit)));
              return out;
            }
          };
        }
      };
    }
  });
}

/** The memos {@link createMemos} returns, each attached to the store's partitions. */

/**
 * A store's `memos` function, which declares a block of memos attached to its partitions. A store's `build` passes it
 * to modules, such as a hydration or a ranker, that declare their own memos.
 */

/**
 * Attaches a block of memo definitions to a store's partitions. Each memo reads its partition's key and version from
 * the store, so callers pass only the parts named in `by`. Declaring them in one block lists everything a store keeps
 * in memory beyond its rows.
 */
export function createMemos(store, binding, decls) {
  const out = {};
  for (const memo of Object.keys(decls)) {
    const keyedBy = ['partition', ...decls[memo].by].join(' + ');
    out[memo] = decls[memo].bind(binding, {
      name: `${store}.${memo}`,
      keyedBy
    });
  }
  return out;
}

/** Whether two records have the same keys and identical (`Object.is`) values, such as two maps of view models by id. */
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
 * Builds an `isEqual` for an object: fields named in `deep` use their given comparison, and every other field
 * `Object.is`. A field left out that holds a newly built object always compares unequal, which costs a re-render
 * rather than a stale value.
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

/** A `{}` and nothing else: a `Map` would answer `Object.keys` with `[]`, and two different ones would compare alike. */
function isPlainRecord(value) {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A one-level comparison: arrays by their elements, plain objects by their values, anything else by identity. It is
 * the default `isEqual` for reads, so a rebuilt list or map of unchanged items doesn't re-render. For a value that
 * needs a deeper comparison, see {@link shallowEqualStruct}.
 */
export function shallowEqualValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left)) return Array.isArray(right) && shallowEqualArray(left, right);
  if (isPlainRecord(left) && isPlainRecord(right)) return shallowEqualRecord(left, right);
  return false;
}

/** Whether two arrays hold identical (`Object.is`) elements in the same order. */
export function shallowEqualArray(left, right) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}
//# sourceMappingURL=caches.js.map