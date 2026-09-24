"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.rowsOf = rowsOf;
/**
 * Turns table rows into a read's value: a list, a list in id order, a record keyed by id, or groups.
 *
 * The shapes are methods on the query's result, because the query already knows what they need, such as which column
 * holds the id and which ids were asked for. Each shape returns the caller's `empty` when no rows are left, so an empty
 * result is always the same object.
 */

/** Columns whose value is always a string, so they can key a `Map` or `Record` directly. */

/** A query's rows, with methods to shape them. */

/** The rows of an `in` query, with extra shapes based on the ids it asked for. */

/** Queries a table and shapes the result in one expression. Created by {@link rowsOf}. */

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

/** Creates a {@link RowReader} for a table, which a hydration uses in place of the table itself. */
function rowsOf(table) {
  return {
    where: (filter, opts) => rowSet(table.find(filter, opts)),
    in: (filter, column, values) => idRowSet(table.findIn(filter, column, values), column, values),
    given: rows => rowSet(rows)
  };
}
//# sourceMappingURL=row_shaping.js.map