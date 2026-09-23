"use strict";

/**
 * A view model per unit, rebuilt only when that unit changed.
 *
 * The problem this exists for. Rows come back from SQLite as fresh objects, so a read that rebuilt its view models on
 * every write would hand its subscribers new references and repaint all of them, whether or not anything they show
 * changed. On the heap that never happened: the response object was shared, so an unchanged entry kept its identity.
 *
 * A projection buys that back. Every write reports the units it changed, so a projection keeps each unit's view model
 * until its unit changes and hands back the same reference until then, which is what lets the shallow-equal comparison
 * above it bail its readers out. A read of named units depends on those units alone, so a write that changed others
 * leaves it asleep. A store declares one per view-model shape and every read of that shape shares it, so a unit is
 * built once however many reads ask for it.
 */

import { byUnit } from "../caches.js";
import { stableKey } from "../args_key.js";
import { createOnceGuard } from "../diagnostics/once_guard.js";
import { covered } from "../table/read_coverage.js";

/** What a store declares: how one unit's rows become a view model, and how many of them to hold. */

/** A declared projection, as the reads of a store consume it. Every method hands back reference-stable view models. */

const thrashWarned = createOnceGuard();

/** The memo a projection holds its view models in: one per unit, and per filter where a filter can cut a unit's rows. */

/** The declaration a projection's memo is built from, so the store accounts for it with every other memo it holds. */
export function rowVmMemo(max) {
  return byUnit()({
    max,
    by: ['scope']
  });
}

/**
 * What a projection needs from the store around it: the rows, how a key addresses them, the memo its view models live
 * in, and the partition's version, which a read over the whole partition depends on.
 */

/** The scope of a read no filter narrows: the unit's whole rows, which every such read shares. */
const WHOLE_UNIT = '';
export function createRowProjection(ctx, def) {
  const {
    store,
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
  const scopeOf = (key, extra) => !extra || isSingleRow(key) || !Object.keys(extra).length ? WHOLE_UNIT : stableKey(extra);
  const warnOnThrash = count => {
    if (!__DEV__ || count <= def.max || thrashWarned.seen(store, def.name)) return;
    // eslint-disable-next-line no-console
    console.warn(`[${store}_store] the '${def.name}' projection was asked for ${count} units but holds ${def.max}, so this read ` + 'evicts what it just built and rebuilds every view model on every change. Raise `max` past the largest read, ' + `or read a narrower slice.${def.advice ? ` ${def.advice}` : ''}`);
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
      out.set(id, rows ? def.of(rows) : undefined);
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
    const members = covered(() => table.unitsWhere(scope));
    return listed(resolve(key, members, extra), members);
  };
  return {
    one: (key, id) => memo.for(key).read(id, WHOLE_UNIT, () => {
      const rows = table.find({
        ...filter(key),
        [unit]: id
      });
      return rows.length ? def.of(rows) : undefined;
    }),
    byIds: (key, ids) => ids.length ? listed(resolve(key, ids), ids) : [],
    mapByIds: (key, ids) => {
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
//# sourceMappingURL=projection.js.map