"use strict";

/**
 * The column declarations a store's SQLite schema, native shred spec, and JS row builder are all generated from, so
 * that one entry defines a persisted column across all three.
 */

/** One declaration per persisted column, in the array's INSERT bind order; a parity test pins `js` and `op` equal. */

/** The type a column resolves to when its `js` builder returns `any`, which would switch off checking for it. */

/** The row type a column table describes: one field per entry, named by `name` and typed by what `js` returns. */

/** The `RowTableSchema['columns']` map a column table describes. */

/** Builds the schema's `columns` map, keyed by the literal column names so a schema can assign it directly. */
export function shredColumnDefs(columns) {
  const defs = {};
  for (const column of columns) defs[column.name] = column.notNull ? {
    type: column.type,
    notNull: true
  } : {
    type: column.type
  };
  return defs;
}

/**
 * The table's column names in declared order, which is the order a `ShredSpec` binds its `columns` and `ops` in. Take
 * both from the same column table, so a column added to one can't go missing from the other.
 */
export function shredColumnNames(columns) {
  return columns.map(column => column.name);
}

/**
 * The native op behind each column, in the same order, for the `ops` of a store's `ShredSpec`. Throws on a column that
 * declares none: a table a store shreds natively has to carry an `op` on every one of its columns.
 */
export function shredColumnOps(columns) {
  return columns.map(column => {
    if (!column.op) throw new Error(`shred_columns: column ${JSON.stringify(column.name)} has no native-shred op`);
    return {
      name: column.name,
      op: column.op
    };
  });
}

/**
 * One row built by running every column's `js` extractor over one element of a payload — the JS ingest a store writes
 * its `parse` in, and the path every store takes on web and in tests, where nothing shreds natively.
 */
export function shredRow(columns, src, ctx) {
  const row = {};
  for (const column of columns) row[column.name] = column.js(src, ctx);
  return row;
}
//# sourceMappingURL=shred_columns.js.map