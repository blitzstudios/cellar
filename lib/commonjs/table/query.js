"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.assertRowsMatchWhere = assertRowsMatchWhere;
exports.comparator = comparator;
exports.matchesWhere = matchesWhere;
exports.whereClause = whereClause;
/** The `where` and ordering predicates the two row-table backends share: SQL on SQLite, the same rules in JS. */

/** Builds a row filter's `WHERE` clause and its binds; an absent value becomes `IS NULL`, the spelling SQL matches on. */
function whereClause(where) {
  const keys = Object.keys(where);
  if (!keys.length) return {
    sql: '',
    params: []
  };
  const clauses = [];
  const params = [];
  for (const key of keys) {
    const value = where[key];
    if (value == null) {
      clauses.push(`${key} IS NULL`);
    } else {
      clauses.push(`${key} = ?`);
      params.push(value);
    }
  }
  return {
    sql: ` WHERE ${clauses.join(' AND ')}`,
    params
  };
}

/** The memory backend's half of {@link whereClause}: whether one row satisfies `where`. */
function matchesWhere(row, where) {
  for (const key of Object.keys(where)) {
    const wanted = where[key];
    const actual = row[key];
    if (wanted == null ? actual != null : actual !== wanted) return false;
  }
  return true;
}

/**
 * Dev-only: every row written under a filter must satisfy it. A row that doesn't lands outside the slice its own
 * write just cleared, where the next write to that slice cannot reach it and no `find` for it expects it.
 */
function assertRowsMatchWhere(table, where, rows) {
  for (const row of rows) {
    if (!matchesWhere(row, where)) {
      const wrong = Object.keys(where).filter(column => !matchesWhere(row, {
        [column]: where[column]
      })).map(column => `\`${column}\` is ${JSON.stringify(row[column])}, not ${JSON.stringify(where[column])}`);
      throw new Error(`row_table: a row written into \`${table}\` does not match the filter it replaced — ${wrong.join(', ')}.`);
    }
  }
}

/**
 * The ordering behind `FindOpts.orderBy`, run in JS by both backends so an ordered `find` comes back in one sequence
 * whichever one served it. A column holding numbers sorts numerically, and everything else compares as a string.
 */
function comparator(orderBy) {
  return (left, right) => {
    const leftValue = left[orderBy];
    const rightValue = right[orderBy];
    if (typeof leftValue === 'number' || typeof rightValue === 'number') {
      return (typeof leftValue === 'number' ? leftValue : 0) - (typeof rightValue === 'number' ? rightValue : 0);
    }
    const leftText = String(leftValue ?? '');
    const rightText = String(rightValue ?? '');
    if (leftText === rightText) return 0;
    return leftText < rightText ? -1 : 1;
  };
}
//# sourceMappingURL=query.js.map