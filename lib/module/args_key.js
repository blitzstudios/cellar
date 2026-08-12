"use strict";

/** Key derivation for reads: a read's cache key is its partition plus the values it is scoped by. */

/** A string that identifies a value by its content, with object keys sorted so equal content yields one key. */
export function stableKey(value) {
  if (value === undefined) return 'u';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'u';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const entries = Object.entries(value).filter(([, value]) => value !== undefined);
  entries.sort((left, right) => left[0] < right[0] ? -1 : 1);
  // Keys are quoted as well as values: unquoted, `{'a:1,b': 2}` and `{a: 1, b: 2}` render the same string.
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${stableKey(value)}`).join(',')}}`;
}

/** A value a read varies by: anything `select` reads beyond the partition itself. */

/** The vary list of a read that declares no `varyBy`, and of one called with no args: one shared array, not a fresh one per call. */
export const EMPTY_VARY = Object.freeze([]);

/** Separator between a key's parts. A control character, since a part may itself contain `:` (`clubsoccer:epl`). */
export const KEY_SEP = '\u0000';

/**
 * The identity of one cache entry, built from the parts that distinguish it: two lookups share an entry exactly when
 * every part matches. Use this for any key in `caches.ts` rather than a template literal or a `join(':')`, which
 * collide two different keys as soon as a part contains `:` itself (`clubsoccer:epl`).
 */
export function cacheKey(...parts) {
  return parts.join(KEY_SEP);
}

/** Separator between groups of parts, one level above {@link KEY_SEP}, so the grouping is part of the key. */
export const GROUP_SEP = '\u0001';

/**
 * The identity of a whole set of partitions, for something keyed by the set rather than by one member — a `readMany`'s
 * cache entry, a `useSelectMany`'s subscription, a fetch over several partitions at once. Order and grouping are both
 * part of the key, so the same partitions named differently are a different set.
 */
export function partitionsKey(partitions) {
  return partitions.map(parts => cacheKey(...parts)).join(GROUP_SEP);
}

/** A partition's parts as a human reads them. Never as a key: `:` occurs inside a part (`clubsoccer:epl`). */
export function partitionLabel(parts) {
  return parts.join(':');
}

/** `undefined`, `null`, `''` and an empty array count as absent; `0` and `false` count as present. */
export function isVaryPresent(value) {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * A read's own cache key: its partition, then everything it varies by, so two calls share a memoized value only when
 * the partition and every vary value match. Vary values go through {@link stableKey}, so an object or array arg keys
 * by its content and a caller rebuilding one per render still hits.
 */
export function varyKey(parts, vary) {
  return vary.length ? cacheKey(...parts, ...vary.map(stableKey)) : cacheKey(...parts);
}
//# sourceMappingURL=args_key.js.map