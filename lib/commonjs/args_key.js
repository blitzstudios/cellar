"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.GROUP_SEP = exports.EMPTY_VARY = void 0;
Object.defineProperty(exports, "KEY_SEP", {
  enumerable: true,
  get: function () {
    return _key.KEY_SEP;
  }
});
Object.defineProperty(exports, "cacheKey", {
  enumerable: true,
  get: function () {
    return _key.cacheKey;
  }
});
exports.isVaryPresent = isVaryPresent;
exports.partitionLabel = partitionLabel;
exports.partitionsKey = partitionsKey;
exports.stableKey = stableKey;
exports.varyKey = varyKey;
var _once_guard = require("./diagnostics/once_guard.js");
var _key = require("./key.js");
/** Key derivation for reads: a read's cache key is its partition plus the values it is scoped by. */

/**
 * A `Map`, a `Set` or a class instance keys as `{}`, since none of what it holds is an own enumerable property — so two
 * different ones would share a cache entry. Caught in dev rather than typed away, because the types that legitimately
 * arrive here are ordinary interfaces, which no `Record` constraint accepts.
 */
const notPlainData = (0, _once_guard.createOnceGuard)();
function warnOnceIfNotPlainData(value) {
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return;
  const name = value.constructor?.name ?? 'an object';
  if (notPlainData.seen(name)) return;
  // eslint-disable-next-line no-console
  console.warn(`[data_kernel] keyed by a ${name}, which is not plain data: only own enumerable properties count towards a key, ` + `so two different ${name}s would key alike and share one cache entry. Key by the values you mean instead.`);
}

/** A string that identifies a value by its content, with object keys sorted so equal content yields one key. */
function stableKey(value) {
  if (value === undefined) return 'u';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'u';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (__DEV__) warnOnceIfNotPlainData(value);
  const entries = Object.entries(value).filter(([, value]) => value !== undefined);
  entries.sort((left, right) => left[0] < right[0] ? -1 : 1);
  // Keys are quoted as well as values: unquoted, `{'a:1,b': 2}` and `{a: 1, b: 2}` render the same string.
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${stableKey(value)}`).join(',')}}`;
}

/**
 * A value a read varies by: anything `select` reads beyond the partition itself. An object or an array keys by its
 * content, so a read can vary by a config or an options object without the caller serializing one — but it must be
 * plain data, since only own enumerable properties count towards the key (see {@link stableKey}).
 */

/** The vary list of a read that declares no `varyBy`, and of one called with no args: one shared array, not a fresh one per call. */
const EMPTY_VARY = exports.EMPTY_VARY = Object.freeze([]);

/** Separator between groups of parts, one level above {@link KEY_SEP}, so the grouping is part of the key. */
const GROUP_SEP = exports.GROUP_SEP = '\u0001';

/**
 * The identity of a whole set of partitions, for something keyed by the set rather than by one member — a `readMany`'s
 * cache entry, a `useSelectMany`'s subscription, a fetch over several partitions at once. Order and grouping are both
 * part of the key, so the same partitions named differently are a different set.
 */
function partitionsKey(partitions) {
  return partitions.map(parts => (0, _key.cacheKey)(...parts)).join(GROUP_SEP);
}

/** A partition's parts as a human reads them. Never as a key: `:` occurs inside a part (`clubsoccer:epl`). */
function partitionLabel(parts) {
  return parts.join(':');
}

/** `undefined`, `null`, `''` and an empty array count as absent; `0` and `false` count as present. */
function isVaryPresent(value) {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * A read's own cache key: its partition, then everything it varies by, so two calls share a memoized value only when
 * the partition and every vary value match. Vary values go through {@link stableKey}, so an object or array arg keys
 * by its content and a caller rebuilding one per render still hits.
 */
function varyKey(parts, vary) {
  return vary.length ? (0, _key.cacheKey)(...parts, ...vary.map(stableKey)) : (0, _key.cacheKey)(...parts);
}
//# sourceMappingURL=args_key.js.map