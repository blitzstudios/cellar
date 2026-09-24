"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineShredColumns = defineShredColumns;
/**
 * A table's columns, declared once as a list and turned into everything else that has to agree with them. A store
 * needs its columns in three places: the table's schema (names and SQLite types), the JS row builder (how each value is
 * computed from a response element), and the native shred program (the same computation, as an op the C++ shredder
 * runs). Declaring each column once, with all three, keeps them from drifting apart.
 */

/**
 * One column of a store's table, declared with everything needed to fill it: its name and SQLite type, and how to
 * compute its value from one element of a response body, both in JS (`js`) and for the native C++ shredder (`op`).
 * An element is one item of the response: one player in a players response, one stat line in a stats response.
 */

/** The type a column resolves to when its `js` builder returns `any`, which would switch off checking for it. */

/**
 * The TypeScript type of one row built from a column list: an object with one field per column, named by the column's
 * `name` and typed by what its `js` function returns. A column whose `js` returns `any` gets an error string as its
 * type instead, so the missing return type gets noticed.
 */

/** The `RowTableSchema['columns']` map a column table describes. */

/** What {@link defineShredColumns} generates from a column list, whether or not every column has an `op`. */

/** The parts of a native shred program generated from a column list; present only when every column has an `op`. */

/**
 * Whether every column carries an `op`. A table one column short of a native shred cannot produce a bind order that
 * matches its columns, so it offers neither member rather than throwing when something reaches for one — which means
 * a store whose payload is small enough to shred in JS never declares an `op` it has no use for.
 */

/**
 * Everything {@link defineShredColumns} generates from one column list: the table's column declarations
 * (`columnDefs`), the column names (`names`), the JS row builder (`row`), and, when every column has an `op`, the
 * ops for a native shred program (`ops`, `namedOps`).
 */

/**
 * Generates everything that has to agree with a table's columns from one list of {@link ShredColumn}s: the schema's
 * column declarations, the JS row builder, and the native shred program's names and ops. Call it with the element type
 * (one item of the response) and the context type (what the store passes per write) first, then the column list:
 *
 * ```ts
 * const itemShred = defineShredColumns<Item, ItemShredCtx>()(ITEM_SHRED_COLUMNS);
 * ```
 */
function defineShredColumns() {
  return columns => {
    const defs = {};
    for (const column of columns) defs[column.name] = column.notNull ? {
      type: column.type,
      notNull: true
    } : {
      type: column.type
    };

    // Derived on first read and kept: the ops are the expensive pair, and a spec built per category asks for them again.
    let named;
    const namedOps = () => named ??= columns.map(column => {
      // Unreachable from TypeScript, which withholds both members from a table missing one; this catches a JS caller.
      if (!column.op) throw new Error(`shred_columns: column ${JSON.stringify(column.name)} has no native-shred op`);
      return {
        name: column.name,
        op: column.op
      };
    });
    return {
      columns,
      names: columns.map(column => column.name),
      columnDefs: defs,
      get namedOps() {
        return namedOps();
      },
      get ops() {
        return namedOps().map(column => column.op);
      },
      row: (src, ctx) => {
        const row = {};
        for (const column of columns) row[column.name] = column.js(src, ctx);
        return row;
      }
    };
  };
}
//# sourceMappingURL=shred_columns.js.map