/** Key derivation for reads: a read's cache key is its partition plus the values it is scoped by. */
export { cacheKey, KEY_SEP } from './key';
/** A string that identifies a value by its content, with object keys sorted so equal content yields one key. */
export declare function stableKey(value: unknown): string;
/**
 * A value a read varies by: anything `select` reads beyond the partition itself. An object or an array keys by its
 * content, so a read can vary by a config or an options object without the caller serializing one — but it must be
 * plain data, since only own enumerable properties count towards the key (see {@link stableKey}).
 */
export type VaryValue = string | number | boolean | null | undefined | readonly unknown[] | object;
/** The vary list of a read that declares no `varyBy`, and of one called with no args: one shared array, not a fresh one per call. */
export declare const EMPTY_VARY: readonly VaryValue[];
/** Separator between groups of parts, one level above {@link KEY_SEP}, so the grouping is part of the key. */
export declare const GROUP_SEP = "\u0001";
/**
 * The identity of a whole set of partitions, for something keyed by the set rather than by one member — a `readMany`'s
 * cache entry, a `useSelectMany`'s subscription, a fetch over several partitions at once. Order and grouping are both
 * part of the key, so the same partitions named differently are a different set.
 */
export declare function partitionsKey(partitions: readonly (readonly string[])[]): string;
/** A partition's parts as a human reads them. Never as a key: `:` occurs inside a part (`clubsoccer:epl`). */
export declare function partitionLabel(parts: readonly string[]): string;
/** `undefined`, `null`, `''` and an empty array count as absent; `0` and `false` count as present. */
export declare function isVaryPresent(value: VaryValue): boolean;
/**
 * A read's own cache key: its partition, then everything it varies by, so two calls share a memoized value only when
 * the partition and every vary value match. Vary values go through {@link stableKey}, so an object or array arg keys
 * by its content and a caller rebuilding one per render still hits.
 */
export declare function varyKey(parts: readonly string[], vary: readonly VaryValue[]): string;
//# sourceMappingURL=args_key.d.ts.map