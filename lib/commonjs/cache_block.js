"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.bindCaches = bindCaches;
var _caches = require("./caches.js");
var _derived_values = require("./read/derived_values.js");
/**
 * A store's cache block: every value the store keeps on the heap beyond its rows, declared together through its
 * partitions ({@linkcode Partitions.cache | cache}). Each entry is one of two kinds, named for what a write discards:
 * a {@linkcode byUnit} cache holds one value per unit and rebuilds only the units a write changed, and a
 * {@linkcode byVersion} cache holds values computed from a whole partition and discards them on any write to it.
 * Nothing here fetches: every value is built from rows already in the table.
 */

/**
 * One entry of a store's {@linkcode Partitions.cache | cache} block: a {@linkcode byVersion} cache, or, where the rows
 * are known, a {@linkcode byUnit} cache.
 */

/**
 * What a {@linkcode Partitions.cache | cache} block returns: one cache per entry, under the entry's key. A
 * {@linkcode byUnit} entry becomes {@linkcode DerivedValues}; a {@linkcode byVersion} entry becomes a cache read through
 * `.for(key)`.
 */

/**
 * A store's {@linkcode Partitions.cache | cache} function, which attaches a block of cache declarations to the store's
 * partitions. A store passes it to modules that declare their own caches, such as a ranker, so every cache the store
 * holds is attached the same way. Without the store's row type, it takes only {@linkcode byVersion} caches.
 */

/** What a {@linkcode byUnit} cache reads its rows through: the store's table, and how a partition key addresses it. */

/**
 * Attaches a cache block to a store: each {@linkcode byVersion} entry to the partitions' versions, and each
 * {@linkcode byUnit} entry to the rows `source` reads as well. Without a `source`, a {@linkcode byUnit} entry throws.
 */
function bindCaches(store, binding, decls, source) {
  const out = {};
  for (const name of Object.keys(decls)) {
    const decl = decls[name];
    if ((0, _derived_values.isUnitCacheDeclaration)(decl)) {
      if (!source) throw new Error(`[${store}] '${name}' is a byUnit cache, which reads a store's rows; declare it in the store's partitions.cache block`);
      const memo = (0, _caches.createMemos)(store, binding, {
        [name]: (0, _derived_values.derivedValueMemo)(decl.def.max)
      })[name];
      out[name] = (0, _derived_values.createDerivedValues)({
        store,
        name,
        table: source.table,
        filter: source.filter,
        memo,
        trackPartition: source.trackPartition
      }, decl.def);
    } else {
      out[name] = (0, _caches.createMemos)(store, binding, {
        [name]: decl
      })[name];
    }
  }
  return out;
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=cache_block.js.map