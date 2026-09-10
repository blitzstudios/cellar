"use strict";

/**
 * Bounded caches for values derived from off-heap rows. A version key answers without a query but misses on every
 * write to the partition; a source key survives that miss and keeps the reference when the rows behind it are
 * unchanged. {@link createVersionedSourceCache} carries both, which is what a value feeding an identity comparison
 * downstream wants. A store reaches these through {@link declareMemos}, which is where it accounts for all of them
 * at once.
 */

import { cacheKey, KEY_SEP, stableKey } from "./args_key.js";
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

/** One entry's place in the recency list: `older` runs toward the coldest end, `newer` toward the hottest. */

/** Builds one holding at most `max` entries. `onEvict` fires for a key dropped for capacity, which is how a cache notices it is undersized. */
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

/**
 * What a memo's key holds beyond the partition: a scalar, or a structured value — a config object, an options subset —
 * which the kernel interns into a short id, so keying by one costs a key the length of an id rather than of its JSON.
 */

/**
 * What a source-keyed memo compares to decide whether the rows behind a value changed: one reference-stable value,
 * compared with `Object.is`, or a list of scalars, which the kernel folds into one string so the caller does not pick
 * a separator that a value could itself contain.
 */

/** One `MemoPart` per name the memo declared in `by`, in that order. */

/** A memo bound to one partition, so neither its key nor its version is the caller's to build. */

/** The same, for a memo that outlives a version bump by comparing what the value was built from. */

/** A declared memo, reached by naming the partition it holds values for. */

/** A memo as declared, before a store's partitions bind it. {@link byVersion} and {@link bySource} are the two. */

/** What a `memos` block's entries are, whatever they hold: what {@link byVersion} and {@link bySource} return. */

/** What a store's partitions lend their memos: how a key addresses a partition, and what version it holds. */

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
    const identity = stableKey(part);
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

/** A source of scalars is folded into one string, so a caller never picks a separator its values could contain. */
function sourceOf(source) {
  return Array.isArray(source) ? source.join(KEY_SEP) : source;
}

/** The last argument of a variadic memo call, and the parts before it. */
function splitArgs(args) {
  return {
    parts: args.slice(0, -1),
    last: args[args.length - 1]
  };
}

/**
 * A memo dropped by every write to its partition. Reach for it when several reads derive the same value from a
 * partition's rows, or when one read consults it once per item: a memo keyed the way a single read is keyed holds
 * only what that read's own memo already holds.
 */
export function byVersion() {
  return spec => ({
    by: spec.by ?? [],
    bind: (store, diagnostics) => {
      const cache = createVersionedCache(spec.max, spec.isEqual, diagnostics);
      const keyer = createPartKeyer();
      return {
        for: key => {
          const prefix = cacheKey(...store.parts(key));
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
 * A memo that outlives the write a version-keyed one is dropped by, because it compares the rows behind the value.
 * Reach for it when the value feeds an identity comparison downstream and a bump elsewhere in the partition should
 * not repaint its readers.
 */
export function bySource() {
  return spec => ({
    by: spec.by ?? [],
    bind: (store, diagnostics) => {
      const cache = createVersionedSourceCache(spec.max, diagnostics);
      const keyer = createPartKeyer();
      return {
        for: key => {
          const prefix = cacheKey(...store.parts(key));
          const version = store.version(key);
          return {
            peek: (...parts) => cache.peek(keyer(prefix, parts), version),
            put: (...args) => {
              const {
                parts,
                last: build
              } = splitArgs(args);
              const source = parts[parts.length - 1];
              return cache.put(keyer(prefix, parts.slice(0, -1)), version, sourceOf(source), build);
            }
          };
        }
      };
    }
  });
}

/** What {@link createMemos} hands back: each declaration, bound to the store whose partitions it holds values for. */

/**
 * A store's `memos` as something to hand around: what a hydration or a ranking module declares its own block with,
 * having been handed it by the backend that called `definePartitions`.
 */

/**
 * Every memo a store holds, declared in one block: what each keeps, how many of them, and what its key holds beyond
 * the partition. Reached through a store's partitions, which is what supplies the rest of a key and the version it is
 * held against — so the block is a complete account of what a store derives onto the heap, and no caller builds a key.
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

/** A `{}` and nothing else: a `Map` would answer `Object.keys` with `[]`, and two different ones would compare alike. */
function isPlainRecord(value) {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * What a read compares its value with when it names no `isEqual`, which is what nearly every read wants: one level,
 * the way a store would have written it by hand — a list by its elements, a record by its values, anything else by
 * identity. A hydration that rebuilds a list or a map out of unchanged parts therefore bails its readers out without
 * being asked to, and a read only names a comparison where one level is not enough (see {@link shallowEqualStruct}).
 */
export function shallowEqualValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left)) return Array.isArray(right) && shallowEqualArray(left, right);
  if (isPlainRecord(left) && isPlainRecord(right)) return shallowEqualRecord(left, right);
  return false;
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