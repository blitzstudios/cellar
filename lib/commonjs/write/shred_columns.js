"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineShredColumns = defineShredColumns;
/**
 * Column lists that a store's SQLite columns, native shred program, and JS row builder are all generated from, so one
 * entry defines a column everywhere.
 */

/** One column of a table, and how to fill it from an element of a response. */

/** The type a column resolves to when its `js` builder returns `any`, which would switch off checking for it. */

/** The row type of a column list: a field per column, typed by what its `js` returns. */

/** The `RowTableSchema['columns']` map a column table describes. */

/** What {@link defineShredColumns} generates from a column list, whether or not every column has an `op`. */

/** The ops for a native shred program, present only when every column has an `op`. */

/**
 * Whether every column carries an `op`. A table one column short of a native shred cannot produce a bind order that
 * matches its columns, so it offers neither member rather than throwing when something reaches for one — which means
 * a store whose payload is small enough to shred in JS never declares an `op` it has no use for.
 */

/**
 * Everything {@link defineShredColumns} generates from a column list: the schema columns, the row builder and, when
 * every column has an `op`, the native ops.
 */

/**
 * Generates a table's schema columns, JS row builder and native shred ops from one column list. Pass the element and
 * context types first, then the columns:
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