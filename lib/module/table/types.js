"use strict";

/** The row table interface: what a store reads and writes its rows through, over any SQLite connection. */

/** One row's column values; `undefined` binds as null, which covers a generated column a category leaves blank. */

/**
 * The storage classes a column can be declared as, and the whole of what a row can hold: a flag is an `INTEGER` of 0
 * or 1, and anything structured is `TEXT` holding its JSON.
 */

/**
 * One column as SQLite will create it. `notNull` is enforced by the database, so a row the constraint rejects fails in
 * a test as it would on device.
 */

/** A secondary index over the columns a read filters on, named so `init` and a bulk write can create and drop it by name. */

/** Etag side-table, keyed by the columns that address a partition. */

/** One row table's declaration: its columns in `INSERT` bind order, which is the `columns` object's key order. */

/** What a `find` takes past its row filter, for a hydration that wants its rows in a column's order rather than in storage order. */

/**
 * The whole contract a store has with its rows — three writes, reads over a `where`, and the ETag pair. Nothing here
 * touches a version atom: a write reports the units it changed, and the partition's ingest is what bumps with them.
 *
 * Every write compares what it was handed with what the table holds and rewrites only the units that differ, so a
 * write whose payload matches the table changes nothing and reports an empty change set.
 */

/** A schema's columns in declaration order, which is the order an `INSERT` binds them and the order the fingerprint hashes. */
export function columnNames(schema) {
  return Object.keys(schema.columns);
}
//# sourceMappingURL=types.js.map