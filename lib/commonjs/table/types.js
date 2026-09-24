"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.columnNames = columnNames;
/** The row table interface: what a store reads and writes its rows through, over any SQLite connection. */

/** A value a SQLite column can hold here: text, a number, or null. */

/**
 * One row, as column name to value. `undefined` binds as null, which covers a generated column a category leaves blank.
 */

/**
 * The type a column is declared as. These three are all a row can hold: a flag is an `INTEGER` of 0 or 1, and anything
 * structured is `TEXT` holding its JSON.
 */

/** One column of a row table: its type, and whether it may be null. */

/** A secondary index over columns a read filters on. */

/** The side table that stores each partition's ETag, so a refetch can send `If-None-Match` and get a 304 back. */

/** Everything a row table is built from: its name, columns, key, unit, indexes and ETag table. */

/** Options for {@link RowTable.find} beyond its row filter. */

/**
 * A store's rows in one SQLite table: writes that report which units changed, reads over a column filter, and each
 * partition's ETag.
 *
 * Every write compares what it was handed with what the table holds and rewrites only the units that differ, so a
 * write whose payload matches the table changes nothing and reports an empty change set. Nothing here bumps a version;
 * the partition's ingest does that with the units a write reports.
 */

/** A schema's column names in declaration order, which is the order an `INSERT` binds them. */
function columnNames(schema) {
  return Object.keys(schema.columns);
}
//# sourceMappingURL=types.js.map