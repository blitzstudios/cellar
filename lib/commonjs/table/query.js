"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.NO_ROW_DIGEST = exports.DIGEST_SEP = void 0;
exports.assertRowsMatchWhere = assertRowsMatchWhere;
exports.comparator = comparator;
exports.digestColumns = digestColumns;
exports.digestRow = digestRow;
exports.matchesWhere = matchesWhere;
exports.whereClause = whereClause;
var _types = require("./types.js");
/** The `where` and ordering predicates the two row-table backends share: SQL on SQLite, the same rules in JS. */

/**
 * Separates the columns of a digest. No column value can hold it, so two rows cannot digest alike by having their
 * values run together. SQLite spells the same character `char(1)`.
 */
const DIGEST_SEP = exports.DIGEST_SEP = '\u0001';

/** Stands for a row the slice does not hold, which is itself worth remembering so a bump does not re-ask for it. */
const NO_ROW_DIGEST = exports.NO_ROW_DIGEST = '\u0000';

/**
 * The columns a digest covers: every one the schema declares, in declaration order.
 *
 * Deliberately not narrowed to the columns outside the caller's filter. A digest is compared against the one held
 * for the same row by a memo that several reads share, so it has to mean the same thing whichever read asked — and a
 * digest that skipped whatever the filter pinned would differ between a read filtered by team and one by id, leaving
 * that memo unable to hit.
 */
function digestColumns(schema) {
  return (0, _types.columnNames)(schema);
}

/**
 * The digest of one row, which is the `Map` backend's half of the SQL expression in `sqlite.ts`.
 *
 * Each backend is self-consistent, which is all a comparison needs. They can still spell a floating-point column
 * differently — SQLite writes a whole number as `1.0` where JS writes `1` — so a store that swaps from `Map`s to
 * SQLite partway through a session rebuilds its values once. That costs a rebuild, never a stale value.
 */
function digestRow(row, columns) {
  let digest = '';
  for (let index = 0; index < columns.length; index += 1) {
    const value = row[columns[index]];
    digest += (index ? DIGEST_SEP : '') + (value == null ? '' : String(value));
  }
  return digest;
}

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