"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineShredColumns = defineShredColumns;
/**
 * The column declarations a store's SQLite schema, native shred spec, and JS row builder are all generated from, so
 * that one entry defines a persisted column across all three.
 */

/** One declaration per persisted column, in the array's INSERT bind order; a parity test pins `js` and `op` equal. */

/** The type a column resolves to when its `js` builder returns `any`, which would switch off checking for it. */

/** The row type a column table describes: one field per entry, named by `name` and typed by what `js` returns. */

/** The `RowTableSchema['columns']` map a column table describes. */

/** What a column table generates whether or not it shreds natively. Every member is derived, so none is a call. */

/** The two a native shred is bound from, which a table only offers once every column can supply one. */

/**
 * Whether every column carries an `op`. A table one column short of a native shred cannot produce a bind order that
 * matches its columns, so it offers neither member rather than throwing when something reaches for one — which means
 * a store like `schedule`, whose payload is small enough to shred in JS, never declares an `op` it has no use for.
 */

/** Everything a column table generates, so a store declares its columns once and derives nothing by hand. */

/**
 * Binds a column table to everything derived from it. Called with the payload and context types first and the columns
 * second, matching how a read is declared:
 *
 * ```ts
 * const playerShred = defineShredColumns<Player, PlayerShredCtx>()(PLAYER_SHRED_COLUMNS);
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

    // Derived on first read and kept: the ops are the expensive pair, and a spec built per sport asks for them again.
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