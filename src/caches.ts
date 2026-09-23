/**
 * Bounded caches for values derived from off-heap rows. A value is held against what it depends on — a partition's
 * version for one derived from the whole partition, a unit's for one derived from that unit's rows — so a write that
 * changed nothing it read leaves it in place, and an `isEqual` keeps the reference when a rebuild changed nothing.
 * A store reaches these through {@link createMemos}, which is where it accounts for all of them at once.
 */

import { identityOf, KEY_SEP, cacheKeyOf } from './args_key';
import { reportStoreDegradation } from './diagnostics/telemetry';
import { Dep, runTracked, trackDependency } from './reactivity/tracking';
import { covered } from './table/read_coverage';

const EVICTION_GHOSTS = 256;
const UNDERSIZED_REPORT_AT = 256;
const NEVER_HIT_REPORT_AT = 512;

/** What a declared memo calls itself in a report, and what its keys are built from. */
export interface MemoDiagnostics {
  name: string;
  keyedBy: string;
}

/**
 * The watch a declared memo carries in dev. It reports one too small for its working set — a key evicted for capacity,
 * then asked for again — and one that has never once answered from its entry, which is heap held for nothing.
 */
function createMemoWatch({ name, keyedBy }: MemoDiagnostics, maxEntries: number) {
  const ghosts = new Set<string>();
  let returned = 0;
  let missed = 0;
  let earned = false;
  return {
    onEvict: (key: string): void => {
      ghosts.add(key);
      if (ghosts.size > EVICTION_GHOSTS) ghosts.delete(ghosts.values().next().value as string);
    },
    /** Call on a lookup that answered from the entry, which is how a memo shows it is earning its heap. */
    noteHit: (): void => {
      earned = true;
    },
    /** Call on a lookup that did not; `absent` separates an evicted key from an entry held at another version. */
    noteMiss: (key: string, absent: boolean): void => {
      if (!earned) {
        missed += 1;
        if (missed === NEVER_HIT_REPORT_AT)
          reportStoreDegradation({
            scope: `memo.never_hit.${name}`,
            context: `${NEVER_HIT_REPORT_AT} lookups keyed by ${keyedBy} never answered from the entry, so whatever calls this already holds the value`,
            extra: { maxEntries },
          });
      }
      if (!absent || !ghosts.delete(key)) return;
      returned += 1;
      if (returned !== UNDERSIZED_REPORT_AT) return;
      reportStoreDegradation({
        scope: `memo.undersized.${name}`,
        context: `${UNDERSIZED_REPORT_AT} keys evicted for capacity were read again, so values keyed by ${keyedBy} are being rebuilt and their readers repainted`,
        extra: { maxEntries },
      });
    },
  };
}

/**
 * A fixed-capacity string-keyed map that drops its coldest entry when full: what every cache in this file is built on,
 * and what a store reaches for to bound a table it keys itself — interned partition records, per-partition timestamps.
 */
export interface BoundedLru<V> {
  /** `undefined` for a missing key and for a stored `undefined` alike; wrap the payload to tell them apart. */
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  /** Least- to most-recently used. */
  keys(): IterableIterator<string>;
}

/** One entry's place in the recency list: `older` runs toward the coldest end, `newer` toward the hottest. */
type LruNode<V> = { key: string; value: V; older: LruNode<V> | undefined; newer: LruNode<V> | undefined };

/** Builds one holding at most `max` entries. `onEvict` fires for a key dropped for capacity, which is how a cache notices it is undersized. */
export function createBoundedLru<V>(max: number, onEvict?: (key: string) => void): BoundedLru<V> {
  const map = new Map<string, LruNode<V>>();
  // Recency rides a linked list rather than `Map` insertion order: reordering by re-inserting
  // allocates a fresh entry on every hit, and hits are the hot path. Relinking mutates nodes.
  let oldest: LruNode<V> | undefined;
  let newest: LruNode<V> | undefined;

  const unlink = (node: LruNode<V>): void => {
    if (node.older) node.older.newer = node.newer;
    else oldest = node.newer;
    if (node.newer) node.newer.older = node.older;
    else newest = node.older;
    node.older = undefined;
    node.newer = undefined;
  };

  const linkNewest = (node: LruNode<V>): void => {
    node.older = newest;
    if (newest) newest.newer = node;
    else oldest = node;
    newest = node;
  };

  const touch = (node: LruNode<V>): void => {
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
      const node: LruNode<V> = { key, value, older: undefined, newer: undefined };
      map.set(key, node);
      linkNewest(node);
      if (map.size > max && oldest !== undefined && oldest !== node) {
        const evicted = oldest;
        unlink(evicted);
        map.delete(evicted.key);
        onEvict?.(evicted.key);
      }
    },
  };
}

/**
 * A memo over values derived from a partition's rows, held against that partition's version, so a read no write
 * invalidated answers from the entry instead of querying the table again. An `isEqual` on top hands back the prior
 * reference when a recompute turned out to change nothing, so a downstream shallow-equal bails and nothing repaints.
 */
export interface VersionedCache<V> {
  /** The value held for `key` at `version`, computed on a miss. */
  read(key: string, version: number, compute: () => V): V;
  /** The entry held for `key` at `version`, wrapped so a stored `undefined` reads as a hit. */
  peek(key: string, version: number): { value: V } | undefined;
  /** Stores `value` and returns the reference to use, which `isEqual` may make a prior one. */
  set(key: string, version: number, value: V): V;
}

/** Builds one. Stores declare theirs through {@link createMemos}; the read surface holds one for presence. */
export function createVersionedCache<V>(maxEntries: number, isEqual?: (prev: V, next: V) => boolean, diagnostics?: MemoDiagnostics): VersionedCache<V> {
  const watch = __DEV__ && diagnostics ? createMemoWatch(diagnostics, maxEntries) : undefined;
  const lru = createBoundedLru<{ version: number; value: V }>(maxEntries, watch?.onEvict);
  const cache: VersionedCache<V> = {
    read(key, version, compute) {
      const hit = cache.peek(key, version);
      return hit ? hit.value : cache.set(key, version, compute());
    },
    peek(key, version) {
      const hit = lru.get(key);
      const found = hit && hit.version === version ? hit : undefined;
      if (watch) {
        if (found) watch.noteHit();
        else watch.noteMiss(key, !hit);
      }
      return found;
    },
    set(key, version, value) {
      // Read by key alone: reference reuse has to survive the bump that triggered the recompute.
      const prior = lru.get(key);
      const stored = prior && isEqual && isEqual(prior.value, value) ? prior.value : value;
      lru.set(key, { version, value: stored });
      return stored;
    },
  };
  return cache;
}

/**
 * A value held against whatever its computation read, which is how the read surface caches a read's result: the
 * computation runs in a tracking scope, and the entry stays valid while every version it reported is unchanged. A read
 * of three players therefore survives a write that changed a fourth. Every lookup reports those same dependencies to
 * the scope above it, hit or miss, so a caller subscribing to what it read never misses one because it was cached.
 */
export interface TrackedCache<V> {
  read(key: string, compute: () => V): V;
}

interface TrackedEntry<V> {
  value: V;
  deps: readonly Dep[];
  versions: readonly number[];
}

/** Builds one. `isEqual` hands back the prior reference when a recompute produced an equal value. */
export function createTrackedCache<V>(maxEntries: number, isEqual?: (prev: V, next: V) => boolean): TrackedCache<V> {
  const lru = createBoundedLru<TrackedEntry<V>>(maxEntries);
  return {
    read(key, compute) {
      const hit = lru.get(key);
      if (hit && hit.deps.every((dep, index) => dep.getVersion() === hit.versions[index])) {
        for (const dep of hit.deps) trackDependency(dep);
        return hit.value;
      }
      const { value, deps } = runTracked(compute);
      const kept = hit && isEqual && isEqual(hit.value, value) ? hit.value : value;
      lru.set(key, { value: kept, deps, versions: deps.map((dep) => dep.getVersion()) });
      for (const dep of deps) trackDependency(dep);
      return kept;
    },
  };
}

/**
 * What a memo's key holds beyond the partition: a scalar, or a structured value — a config object, an options subset —
 * which the kernel interns into a short id, so keying by one costs a key the length of an id rather than of its JSON.
 */
export type MemoPart = string | number | boolean | null | undefined | readonly unknown[] | Record<string, unknown>;

/** One `MemoPart` per name the memo declared in `by`, in that order. */
type PartsOf<By extends readonly string[]> = { -readonly [Index in keyof By]: MemoPart };

/** A memo bound to one partition, so neither its key nor its version is the caller's to build. */
export interface BoundVersionMemo<V, By extends readonly string[]> {
  /** The value held for these parts at the partition's current version, computed on a miss. */
  read(...args: [...PartsOf<By>, build: () => V]): V;
  /** The entry held for these parts, wrapped so a stored `undefined` reads as a hit. */
  peek(...parts: PartsOf<By>): { value: V } | undefined;
  /** Stores a value and returns the reference to use, which `isEqual` may make a prior one. */
  set(...args: [...PartsOf<By>, value: V]): V;
}

/**
 * A memo bound to one partition whose entries each belong to one unit, and stay valid until that unit changes. Every
 * lookup reports the unit it names, so a read built from these depends on those units and nothing else.
 */
export interface BoundUnitMemo<V, By extends readonly string[]> {
  /** The value held for `unit` and these parts, built on a miss or once the unit has changed. */
  read(unit: string, ...args: [...PartsOf<By>, build: () => V]): V;
  /**
   * The values for `units`, answering what it holds and building every miss in one call, so a read of a roster costs
   * one query for the players that changed rather than one each. `build` is handed the units to build and answers for
   * each; a unit it leaves out is held as absent.
   */
  readMany(units: readonly string[], ...args: [...PartsOf<By>, build: (missing: readonly string[]) => ReadonlyMap<string, V>]): Map<string, V>;
}

/** A declared memo, reached by naming the partition it holds values for. */
export interface Memo<Key, Bound> {
  for(key: Key): Bound;
}

/** A memo as declared, before a store's partitions bind it. {@link byVersion} and {@link byUnit} are the two. */
interface MemoDecl<Bound> {
  by: readonly string[];
  bind(store: PartitionBinding<unknown>, diagnostics: MemoDiagnostics): Memo<unknown, Bound>;
}

/** What a `memos` block's entries are, whatever they hold: what {@link byVersion} and {@link byUnit} return. */
export type MemoDeclaration = MemoDecl<unknown>;

/** What a store's partitions lend their memos: how a key addresses a partition, and what version it holds. */
export interface PartitionBinding<Key> {
  parts: (key: Key) => readonly string[];
  /** The partition's version. Tracks the partition. */
  version: (key: Key) => number;
  /** The version one unit last changed at. Tracks that unit alone. */
  unitVersion: (key: Key, unit: string) => number;
}

const INTERNED_PARTS_MAX = 256;

/**
 * Turns a memo's parts into one key. A structured part is interned rather than spelled out: two lookups passing equal
 * content get the same id, and a memo of thousands of entries holds ids instead of repeated JSON. An id evicted for
 * capacity costs a rebuild, never a wrong answer.
 */
function createPartKeyer(): (prefix: string, parts: readonly MemoPart[]) => string {
  const ids = createBoundedLru<string>(INTERNED_PARTS_MAX);
  let nextId = 0;
  const idFor = (part: object): string => {
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
function splitArgs<T>(args: readonly unknown[]): { parts: readonly MemoPart[]; last: T } {
  return { parts: args.slice(0, -1) as readonly MemoPart[], last: args[args.length - 1] as T };
}

/**
 * A memo dropped by every write to its partition. Reach for it when several reads derive the same value from a
 * partition's rows, or when one read consults it once per item: a memo keyed the way a single read is keyed holds
 * only what that read's own memo already holds.
 */
export function byVersion<V>() {
  return <const By extends readonly string[] = readonly []>(spec: {
    max: number;
    /** What the key holds beyond the partition, in order. A memo keyed by the partition alone names nothing. */
    by?: By;
    isEqual?: (prev: V, next: V) => boolean;
  }): MemoDecl<BoundVersionMemo<V, By>> => ({
    by: spec.by ?? [],
    bind: (store, diagnostics) => {
      const cache = createVersionedCache<V>(spec.max, spec.isEqual, diagnostics);
      const keyer = createPartKeyer();
      return {
        for: (key) => {
          const prefix = cacheKeyOf(store.parts(key));
          const version = store.version(key);
          return {
            read: (...args) => {
              const { parts, last } = splitArgs<() => V>(args);
              return cache.read(keyer(prefix, parts), version, last);
            },
            peek: (...parts) => cache.peek(keyer(prefix, parts), version),
            set: (...args) => {
              const { parts, last } = splitArgs<V>(args);
              return cache.set(keyer(prefix, parts), version, last);
            },
          };
        },
      };
    },
  });
}

/**
 * A memo whose entries each belong to one unit — a player, a team — and survive every write that did not change that
 * unit. Reach for it for a value built from one unit's rows: a write that changed other units leaves the entry and its
 * reference alone, and a read built from it depends on the units it names and nothing else.
 *
 * A build's table reads are covered by the unit it reports, so they do not widen the read around it to the partition.
 */
export function byUnit<V>() {
  return <const By extends readonly string[] = readonly []>(spec: {
    max: number;
    /** What the key holds beyond the partition and the unit, in order. */
    by?: By;
    isEqual?: (prev: V, next: V) => boolean;
  }): MemoDecl<BoundUnitMemo<V, By>> => ({
    by: spec.by ?? [],
    bind: (store, diagnostics) => {
      const watch = __DEV__ ? createMemoWatch(diagnostics, spec.max) : undefined;
      const lru = createBoundedLru<{ version: number; value: V }>(spec.max, watch?.onEvict);
      const keyer = createPartKeyer();
      /** The entry for this key if it was built at the unit's current version; noted as a hit or a miss. */
      const current = (key: string, version: number): { value: V } | undefined => {
        const hit = lru.get(key);
        const found = hit && hit.version === version ? hit : undefined;
        if (watch) {
          if (found) watch.noteHit();
          else watch.noteMiss(key, !hit);
        }
        return found;
      };
      const store_ = (key: string, version: number, value: V): V => {
        const prior = lru.get(key);
        const kept = prior && spec.isEqual && spec.isEqual(prior.value, value) ? prior.value : value;
        lru.set(key, { version, value: kept });
        return kept;
      };
      return {
        for: (key) => {
          const prefix = cacheKeyOf(store.parts(key));
          const entryKey = (unit: string, parts: readonly MemoPart[]): string => keyer(`${prefix}${KEY_SEP}${unit}`, parts);
          return {
            read: (unit, ...args) => {
              const { parts, last: build } = splitArgs<() => V>(args);
              const version = store.unitVersion(key, unit);
              const at = entryKey(unit, parts);
              const hit = current(at, version);
              return hit ? hit.value : store_(at, version, covered(build));
            },
            readMany: (units, ...args) => {
              const { parts, last: build } = splitArgs<(missing: readonly string[]) => ReadonlyMap<string, V>>(args);
              const out = new Map<string, V>();
              const missing: Array<{ unit: string; at: string; version: number }> = [];
              for (const unit of units) {
                const version = store.unitVersion(key, unit);
                const at = entryKey(unit, parts);
                const hit = current(at, version);
                if (hit) out.set(unit, hit.value);
                else missing.push({ unit, at, version });
              }
              if (!missing.length) return out;
              const built = covered(() => build(missing.map((entry) => entry.unit)));
              for (const { unit, at, version } of missing) out.set(unit, store_(at, version, built.get(unit) as V));
              return out;
            },
          };
        },
      };
    },
  });
}

/** What {@link createMemos} hands back: each declaration, bound to the store whose partitions it holds values for. */
export type BoundMemos<Key, D> = { [K in keyof D]: D[K] extends MemoDecl<infer Bound> ? Memo<Key, Bound> : never };

/**
 * A store's `memos` as something to hand around: what a hydration or a ranking module declares its own block with,
 * having been handed it by the store's `build` that called `definePartitions`.
 */
export type MemoFactory<Key> = <D extends Record<string, MemoDeclaration>>(decls: D) => BoundMemos<Key, D>;

/**
 * Every memo a store holds, declared in one block: what each keeps, how many of them, and what its key holds beyond
 * the partition. Reached through a store's partitions, which is what supplies the rest of a key and the version it is
 * held against — so the block is a complete account of what a store derives onto the heap, and no caller builds a key.
 */
export function createMemos<Key, D extends Record<string, MemoDeclaration>>(
  store: string,
  binding: PartitionBinding<Key>,
  decls: D,
): BoundMemos<Key, D> {
  const out = {} as Record<string, unknown>;
  for (const memo of Object.keys(decls)) {
    const keyedBy = ['partition', ...decls[memo].by].join(' + ');
    out[memo] = decls[memo].bind(binding as PartitionBinding<unknown>, { name: `${store}.${memo}`, keyedBy });
  }
  return out as BoundMemos<Key, D>;
}

/**
 * The `isEqual` for a read handing back a record of reference-stable values, which a hydration's map of VMs by id is:
 * a rebuilt map whose entries are the same references is not a change, so its readers do not repaint.
 */
export function shallowEqualRecord<V>(left: Record<string, V>, right: Record<string, V>): boolean {
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
export function shallowEqualStruct<T extends object>(deep: { [K in keyof T]?: (left: T[K], right: T[K]) => boolean }): (left: T, right: T) => boolean {
  return (left, right) => {
    if (left === right) return true;
    const keys = Object.keys(left) as (keyof T)[];
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
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * What a read compares its value with when it names no `isEqual`, which is what nearly every read wants: one level,
 * the way a store would have written it by hand — a list by its elements, a record by its values, anything else by
 * identity. A hydration that rebuilds a list or a map out of unchanged parts therefore bails its readers out without
 * being asked to, and a read only names a comparison where one level is not enough (see {@link shallowEqualStruct}).
 */
export function shallowEqualValue<T>(left: T, right: T): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left)) return Array.isArray(right) && shallowEqualArray(left, right);
  if (isPlainRecord(left) && isPlainRecord(right)) return shallowEqualRecord(left, right);
  return false;
}

/** The same `isEqual` for a read handing back a list: a re-run that produced the same values in the same order is not a change. */
export function shallowEqualArray<V>(left: readonly V[], right: readonly V[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}
