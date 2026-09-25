"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.byUnit = byUnit;
exports.createDerivedValues = createDerivedValues;
exports.derivedValueMemo = derivedValueMemo;
exports.isUnitCacheDeclaration = isUnitCacheDeclaration;
var _caches = require("../caches.js");
var _args_key = require("../args_key.js");
var _once_guard = require("../diagnostics/once_guard.js");
var _read_coverage = require("../table/read_coverage.js");
/**
 * {@linkcode byUnit} caches: a value derived from each unit's rows, usually a view model, cached per unit.
 *
 * A unit is all the rows sharing one value of the table's unit column, such as one player's rows (`player_id`). Derived
 * values turn a unit's rows into a value (typically the object a screen renders), keep it, and return the same object
 * until a write changes that unit's rows. Rows come out of SQLite as new objects on every query, so without this, every
 * read after every write would build new values and re-render every component showing one, changed or not.
 *
 * Every write reports which units it changed, so only those units' values are rebuilt. A read that asks for particular
 * units ({@linkcode DerivedValues.at | at}, {@linkcode DerivedValues.atEach | atEach}) depends on just those units, so
 * a write to other units doesn't re-run it. A store declares one set of derived values per shape, and every read of
 * that shape shares it, so each unit's value is built once however many reads ask for it.
 */

/**
 * The definition of a {@linkcode byUnit} cache: how to build one unit's value from its rows (usually a view model), and
 * how many built values to keep. A unit is all the rows sharing one value of the table's unit column, such as one
 * player's rows. The cache's name, shown in warnings, is its key in the {@linkcode Partitions.cache | cache} block.
 */

/**
 * A {@linkcode byUnit} cache as a store's {@linkcode Partitions.cache | cache} block returns it: one value per unit, built from the unit's rows (usually a
 * view model), cached, and returned as the same object until a write changes that unit's rows. A unit is all the rows
 * sharing one value of the table's unit column, such as one player's rows.
 *
 * Each value's address is a partition key plus a unit id (a partition is the set of rows one fetch returns and
 * replaces), so every method takes the key first and reads only that partition's rows. Reads call these methods in
 * their {@linkcode ReadDef.select | select}. Name a set after what it holds and the unit it is keyed by, such as
 * `cardsByPlayer`.
 */

/**
 * A {@linkcode byUnit} cache's definition, as {@linkcode byUnit} returns it, before a store's
 * {@linkcode Partitions.cache | cache} block attaches it to the store's partitions.
 */

/**
 * Declares a cache of values derived from each unit's rows, usually view models, for a store's
 * {@linkcode Partitions.cache | cache} block: one value per unit (a unit is all the rows sharing one value of the
 * table's unit column, such as one player's rows), built from that unit's rows by `fromRows` on first use and kept, as
 * the same object, until a write changes that unit's rows. Reads look values up by partition key and unit id through the
 * {@linkcode DerivedValues} methods, such as {@linkcode DerivedValues.at | at}.
 *
 * Called in two steps, so the value type can be given while the row type comes from the store:
 * `byUnit<GameVM[]>()({ max: 2048, fromRows: rowsToTeamGames })`.
 */
function byUnit() {
  return def => ({
    kind: 'byUnit',
    def
  });
}

/** Whether a {@linkcode Partitions.cache | cache} block entry is a {@linkcode byUnit} cache. */
function isUnitCacheDeclaration(decl) {
  return typeof decl === 'object' && decl !== null && decl.kind === 'byUnit';
}
const thrashWarned = (0, _once_guard.createOnceGuard)();

/**
 * The memo a {@linkcode byUnit} cache keeps its values in: one per unit, and per filter where a filter can cut a unit's
 * rows.
 */

/** The declaration a {@linkcode byUnit} cache's memo is built from. */
function derivedValueMemo(max) {
  return (0, _caches.unitMemo)()({
    max,
    by: ['scope']
  });
}

/**
 * What a {@linkcode byUnit} cache needs from the store around it: its name, the rows, how a key addresses them, the
 * memo its values live in, and the partition's version, which a read over the whole partition depends on.
 */

/** The scope of a read no filter narrows: the unit's whole rows, which every such read shares. */
const WHOLE_UNIT = '';
function createDerivedValues(ctx, def) {
  const {
    store,
    name,
    table,
    filter,
    memo,
    trackPartition
  } = ctx;
  const unit = table.unit;

  /**
   * Whether a unit is one row, which is what decides if a filtered read can share its view model with an unfiltered
   * one. With one row per unit, a filter either includes the unit's row or not, so every read builds the same view
   * model from it. With several, a filter can include some of a unit's rows — a traded player's games for one team —
   * and the view model built from those is a different one, held under the filter. Worked out from the first key,
   * since the partition's filter is a function of one; the same for every key of a store.
   */
  let singleRow;
  const isSingleRow = key => {
    if (singleRow === undefined) {
      const fixed = new Set(Object.keys(filter(key)));
      const rest = table.primaryKey.filter(column => !fixed.has(column));
      singleRow = rest.length === 1 && rest[0] === unit;
    }
    return singleRow;
  };
  const scopeOf = (key, extra) => !extra || isSingleRow(key) || !Object.keys(extra).length ? WHOLE_UNIT : (0, _args_key.stableKey)(extra);
  const warnOnThrash = count => {
    if (!__DEV__ || count <= def.max || thrashWarned.seen(store, name)) return;
    // eslint-disable-next-line no-console
    console.warn(`[${store}_store] the '${name}' cache was asked for ${count} units but holds ${def.max}, so this read ` + 'evicts what it just built and rebuilds every value on every change. Raise `max` past the largest read, ' + `or read a narrower slice.${def.advice ? ` ${def.advice}` : ''}`);
  };

  /** Builds the view models for `units` from one query, grouped by unit in storage order. */
  const buildMany = (scope, units) => {
    const grouped = new Map();
    for (const row of table.findIn(scope, unit, units)) {
      const id = String(row[unit]);
      const list = grouped.get(id);
      if (list) list.push(row);else grouped.set(id, [row]);
    }
    const out = new Map();
    for (const id of units) {
      const rows = grouped.get(id);
      out.set(id, rows ? def.fromRows(rows) : undefined);
    }
    return out;
  };
  function resolve(key, ids, extra) {
    warnOnThrash(ids.length);
    const scope = extra ? {
      ...filter(key),
      ...extra
    } : filter(key);
    return memo.for(key).readMany(ids, scopeOf(key, extra), missing => buildMany(scope, missing));
  }
  const listed = (resolved, order) => {
    const out = [];
    for (const id of order) {
      const vm = resolved.get(id);
      if (vm !== undefined) out.push(vm);
    }
    return out;
  };
  const overFilter = (key, extra) => {
    // Which units the filter holds can change with any write to the partition, so this depends on all of it.
    trackPartition(key);
    const scope = extra ? {
      ...filter(key),
      ...extra
    } : filter(key);
    const members = (0, _read_coverage.covered)(() => table.unitsWhere(scope));
    return listed(resolve(key, members, extra), members);
  };
  return {
    at: (key, id) => memo.for(key).read(id, WHOLE_UNIT, () => {
      const rows = table.find({
        ...filter(key),
        [unit]: id
      });
      return rows.length ? def.fromRows(rows) : undefined;
    }),
    atEach: (key, ids) => ids.length ? listed(resolve(key, ids), ids) : [],
    pick: (key, ids) => {
      const out = {};
      if (!ids.length) return out;
      const resolved = resolve(key, ids);
      for (const id of ids) {
        const vm = resolved.get(id);
        if (vm !== undefined) out[id] = vm;
      }
      return out;
    },
    where: (key, extra) => overFilter(key, extra),
    all: key => overFilter(key)
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=derived_values.js.map