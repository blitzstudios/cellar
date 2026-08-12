"use strict";

/**
 * Shapers that turn a partition's rows into a read's value: a list, an id-ordered list, a keyed record, or groups.
 * Each hands back the caller's stable `empty` when nothing survives, so an empty result keeps one identity. Their
 * mappers are `NoInfer`, since inferring `Row` from a mapper that takes `Row | undefined` collapses `keyof Row`.
 */

/** Columns whose value is always a string, so they can key a `Map` or `Record` directly. */

/**
 * The plain shape, and the one a hydration reaches for unless it needs another: every row through the mapper, dropping
 * the ones it turns down. The order is the query's, so a read that owes its caller an order asks the query for it.
 */
export function mapRows(rows, toVm, empty) {
  const out = [];
  for (const row of rows) {
    const vm = toVm(row);
    if (vm) out.push(vm);
  }
  return out.length ? out : empty;
}

/** The rows in the order `ids` asked for, which SQL `IN` and `findIn`'s chunking both scramble. */
export function orderedByIds(rows, idColumn, ids, toVm, empty) {
  const byId = new Map();
  for (const row of rows) byId.set(row[idColumn], row);
  const out = [];
  for (const id of ids) {
    const row = byId.get(id);
    const vm = row ? toVm(row) : undefined;
    if (vm) out.push(vm);
  }
  return out.length ? out : empty;
}

/** On a duplicate key, the last row wins. */
export function indexRowsBy(rows, column, toVm, empty) {
  const out = {};
  let found = false;
  for (const row of rows) {
    const vm = toVm(row);
    if (vm) {
      out[row[column]] = vm;
      found = true;
    }
  }
  return found ? out : empty;
}

/** Each group is in the order the rows arrived. */
export function groupRowsBy(rows, column) {
  const grouped = new Map();
  for (const row of rows) {
    const value = row[column];
    const list = grouped.get(value);
    if (list) list.push(row);else grouped.set(value, [row]);
  }
  return grouped;
}
//# sourceMappingURL=row_shaping.js.map