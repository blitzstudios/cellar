/**
 * The column declarations a store's SQLite schema, native shred spec, and JS row builder are all generated from, so
 * that one entry defines a persisted column across all three.
 */
import { ColumnDef, ColumnType, SqlValue } from '../table/types';
import { ShredOp } from './shred_spec';
/** One declaration per persisted column, in the array's INSERT bind order; a parity test pins `js` and `op` equal. */
export interface ShredColumn<Src, Ctx = void> {
    name: string;
    type: ColumnType;
    notNull?: boolean;
    js: (src: Src, ctx: Ctx) => SqlValue;
    /** Present where a store shreds natively; `js` alone carries the ingest everywhere else. */
    op?: ShredOp;
}
/** The type a column resolves to when its `js` builder returns `any`, which would switch off checking for it. */
type AnnotateTheBuilder = 'this column`s js builder returns any: give it an explicit return type';
/** The row type a column table describes: one field per entry, named by `name` and typed by what `js` returns. */
export type RowOf<Columns extends readonly ShredColumn<never, never>[]> = {
    [Column in Columns[number] as Column['name']]: 0 extends 1 & ReturnType<Column['js']> ? AnnotateTheBuilder : ReturnType<Column['js']>;
};
/** The `RowTableSchema['columns']` map a column table describes. */
type ColumnDefsOf<Columns extends readonly ShredColumn<never, never>[]> = {
    [Column in Columns[number] as Column['name']]: ColumnDef;
};
/** What a column table generates whether or not it shreds natively. Every member is derived, so none is a call. */
interface ShredColumnsBase<Columns extends readonly ShredColumn<never, never>[], Src, Ctx> {
    /** The declarations themselves, for a store composing one spec out of these columns and more. */
    columns: Columns;
    /**
     * The column names in declared order, which is the order a `ShredSpec` binds its `columns` and `ops` in. Both come
     * from this one table, so a column added to the shred can't go missing from the bind.
     */
    names: string[];
    /** The `RowTableSchema['columns']` map, keyed by the literal names so a schema can assign or spread it. */
    columnDefs: ColumnDefsOf<Columns>;
    /**
     * One row, built by running every column's `js` extractor over one element of a payload — the JS ingest a store
     * writes its `parse` in, and the path every store takes on web and in tests, where nothing shreds natively. Typed
     * as the row the columns describe, so no ingest has to assert its own row type.
     */
    row: (src: Src, ctx: Ctx) => RowOf<Columns>;
}
/** The two a native shred is bound from, which a table only offers once every column can supply one. */
interface NativeShredColumns {
    /** `{ name, op }` per column, in order, for a spec concatenating these columns with others. */
    namedOps: {
        name: string;
        op: ShredOp;
    }[];
    /** Just the ops, in the same order, for a spec built from these columns alone. */
    ops: ShredOp[];
}
/**
 * Whether every column carries an `op`. A table one column short of a native shred cannot produce a bind order that
 * matches its columns, so it offers neither member rather than throwing when something reaches for one — which means
 * a store like `schedule`, whose payload is small enough to shred in JS, never declares an `op` it has no use for.
 */
type EveryColumnShreds<Columns extends readonly ShredColumn<never, never>[]> = Columns[number] extends {
    op: ShredOp;
} ? true : false;
/** Everything a column table generates, so a store declares its columns once and derives nothing by hand. */
export type ShredColumns<Columns extends readonly ShredColumn<never, never>[], Src, Ctx> = ShredColumnsBase<Columns, Src, Ctx> & (EveryColumnShreds<Columns> extends true ? NativeShredColumns : unknown);
/**
 * Binds a column table to everything derived from it. Called with the payload and context types first and the columns
 * second, matching how a read is declared:
 *
 * ```ts
 * const playerShred = defineShredColumns<Player, PlayerShredCtx>()(PLAYER_SHRED_COLUMNS);
 * ```
 */
export declare function defineShredColumns<Src, Ctx = void>(): <const Columns extends readonly ShredColumn<Src, Ctx>[]>(columns: Columns) => ShredColumns<Columns, Src, Ctx>;
export {};
//# sourceMappingURL=shred_columns.d.ts.map