"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.rowsOf = rowsOf;
/**
 * Turning a partition's rows into a read's value: a list, an id-ordered list, a keyed record, or groups.
 *
 * The shaping hangs off the query rather than standing beside it, because everything a shaper needs — which column
 * holds the id, which ids were asked for — is something the query was already told. A hydration that says it twice can
 * say it two different ways, and the shapes it hands back would disagree with the rows it holds.
 *
 * Each shape hands back the caller's stable `empty` when nothing survives, so an empty result keeps one identity and
 * the read's bail-out holds. A row set costs one object per query, which is noise beside the query's own row array,
 * and a hydration only reaches one on a cache miss.
 */

/** Columns whose value is always a string, so they can key a `Map` or `Record` directly. */

/** Rows in hand, and the shapes any set of them can take. */

/** The rows an `in` query matched, which can additionally be shaped around the ids it named. */

/** A table's rows, queried and shaped in one expression. Built once per hydration by {@link rowsOf}. */

function groupRows(rows, column) {
  const grouped = new Map();
  for (const row of rows) {
    const value = row[column];
    const list = grouped.get(value);
    if (list) list.push(row);else grouped.set(value, [row]);
  }
  return grouped;
}
function rowSet(rows) {
  return {
    rows,
    map(toVm, empty) {
      const out = [];
      for (const row of rows) {
        const vm = toVm(row);
        if (vm) out.push(vm);
      }
      return out.length ? out : empty;
    },
    groupBy: column => groupRows(rows, column)
  };
}
function idRowSet(rows, column, ids) {
  return {
    ...rowSet(rows),
    ordered(toVm, empty) {
      const byId = new Map();
      for (const row of rows) byId.set(row[column], row);
      const out = [];
      for (const id of ids) {
        const row = byId.get(id);
        const vm = row ? toVm(row) : undefined;
        if (vm) out.push(vm);
      }
      return out.length ? out : empty;
    },
    indexed(toVm, empty) {
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
    },
    grouped: () => groupRows(rows, column)
  };
}

/** Binds the shapes above to one table, which is what a hydration holds instead of the table itself. */
function rowsOf(table) {
  return {
    where: (filter, opts) => rowSet(table.find(filter, opts)),
    in: (filter, column, values) => idRowSet(table.findIn(filter, column, values), column, values),
    given: rows => rowSet(rows)
  };
}
//# sourceMappingURL=row_shaping.js.map