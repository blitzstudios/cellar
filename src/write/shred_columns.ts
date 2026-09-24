/**
 * Column lists that a store's SQLite columns, native shred program, and JS row builder are all generated from, so one
 * entry defines a column everywhere.
 */

import { ColumnDef, ColumnType, SqlValue } from '../table/types';
import { ShredOp } from './shred_spec';

/** One column of a table, and how to fill it from an element of a response. */
export interface ShredColumn<Src, Ctx = void> {
  /** The column's name. */
  name: string;
  /** The column's SQLite type. */
  type: ColumnType;
  /** Makes the column `NOT NULL`. */
  notNull?: boolean;
  /** Computes the column's value from one element, in JS. Used on web, in tests, and wherever there is no `op`. */
  js: (src: Src, ctx: Ctx) => SqlValue;
  /**
   * How the native shredder computes the same value; a parity test checks the two agree. Only needed to shred natively.
   */
  op?: ShredOp;
}

/** The type a column resolves to when its `js` builder returns `any`, which would switch off checking for it. */
type AnnotateTheBuilder = 'this column`s js builder returns any: give it an explicit return type';

/** The row type of a column list: a field per column, typed by what its `js` returns. */
export type RowOf<Columns extends readonly ShredColumn<never, never>[]> = {
  [Column in Columns[number] as Column['name']]: 0 extends 1 & ReturnType<Column['js']> ? AnnotateTheBuilder : ReturnType<Column['js']>;
};

/** The `RowTableSchema['columns']` map a column table describes. */
type ColumnDefsOf<Columns extends readonly ShredColumn<never, never>[]> = {
  [Column in Columns[number] as Column['name']]: ColumnDef;
};

/** What {@link defineShredColumns} generates from a column list, whether or not every column has an `op`. */
interface ShredColumnsBase<Columns extends readonly ShredColumn<never, never>[], Src, Ctx> {
  /** The column list itself, for building a program from these columns and others. */
  columns: Columns;
  /** The column names in order, for a `ShredSpec`'s `columns`, which must match the order of its `ops`. */
  names: string[];
  /** The columns as a `RowTableSchema['columns']` map, for the table's schema. */
  columnDefs: ColumnDefsOf<Columns>;
  /**
   * Builds one row from one element by running every column's `js`. A store's `parse` uses it, and it is how rows are
   * built on web and in tests, where nothing shreds natively.
   */
  row: (src: Src, ctx: Ctx) => RowOf<Columns>;
}

/** The ops for a native shred program, present only when every column has an `op`. */
interface NativeShredColumns {
  /** Each column's name and op, in order, for a program combining these columns with others. */
  namedOps: { name: string; op: ShredOp }[];
  /** Each column's op, in order, for a program using only these columns. */
  ops: ShredOp[];
}

/**
 * Whether every column carries an `op`. A table one column short of a native shred cannot produce a bind order that
 * matches its columns, so it offers neither member rather than throwing when something reaches for one — which means
 * a store whose payload is small enough to shred in JS never declares an `op` it has no use for.
 */
type EveryColumnShreds<Columns extends readonly ShredColumn<never, never>[]> = Columns[number] extends { op: ShredOp } ? true : false;

/**
 * Everything {@link defineShredColumns} generates from a column list: the schema columns, the row builder and, when
 * every column has an `op`, the native ops.
 */
export type ShredColumns<Columns extends readonly ShredColumn<never, never>[], Src, Ctx> = ShredColumnsBase<Columns, Src, Ctx> &
  (EveryColumnShreds<Columns> extends true ? NativeShredColumns : unknown);

/**
 * Generates a table's schema columns, JS row builder and native shred ops from one column list. Pass the element and
 * context types first, then the columns:
 *
 * ```ts
 * const itemShred = defineShredColumns<Item, ItemShredCtx>()(ITEM_SHRED_COLUMNS);
 * ```
 */
export function defineShredColumns<Src, Ctx = void>() {
  return <const Columns extends readonly ShredColumn<Src, Ctx>[]>(columns: Columns): ShredColumns<Columns, Src, Ctx> => {
    const defs: Record<string, ColumnDef> = {};
    for (const column of columns) defs[column.name] = column.notNull ? { type: column.type, notNull: true } : { type: column.type };

    // Derived on first read and kept: the ops are the expensive pair, and a spec built per category asks for them again.
    let named: { name: string; op: ShredOp }[] | undefined;
    const namedOps = (): { name: string; op: ShredOp }[] =>
      (named ??= columns.map((column) => {
        // Unreachable from TypeScript, which withholds both members from a table missing one; this catches a JS caller.
        if (!column.op) throw new Error(`shred_columns: column ${JSON.stringify(column.name)} has no native-shred op`);
        return { name: column.name, op: column.op };
      }));

    return {
      columns,
      names: columns.map((column) => column.name),
      columnDefs: defs as ColumnDefsOf<Columns>,
      get namedOps() {
        return namedOps();
      },
      get ops() {
        return namedOps().map((column) => column.op);
      },
      row: (src, ctx) => {
        const row: Record<string, SqlValue> = {};
        for (const column of columns) row[column.name] = column.js(src, ctx);
        return row as RowOf<Columns>;
      },
    } as ShredColumns<Columns, Src, Ctx>;
  };
}
