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
/** Builds the schema's `columns` map, keyed by the literal column names so a schema can assign it directly. */
export declare function shredColumnDefs<Columns extends readonly ShredColumn<never, never>[]>(columns: Columns): ColumnDefsOf<Columns>;
/**
 * The table's column names in declared order, which is the order a `ShredSpec` binds its `columns` and `ops` in. Take
 * both from the same column table, so a column added to one can't go missing from the other.
 */
export declare function shredColumnNames<S, C>(columns: readonly ShredColumn<S, C>[]): string[];
/**
 * The native op behind each column, in the same order, for the `ops` of a store's `ShredSpec`. Throws on a column that
 * declares none: a table a store shreds natively has to carry an `op` on every one of its columns.
 */
export declare function shredColumnOps<S, C>(columns: readonly ShredColumn<S, C>[]): {
    name: string;
    op: ShredOp;
}[];
/**
 * One row built by running every column's `js` extractor over one element of a payload — the JS ingest a store writes
 * its `parse` in, and the path every store takes on web and in tests, where nothing shreds natively.
 */
export declare function shredRow<S, C>(columns: readonly ShredColumn<S, C>[], src: S, ctx: C): Record<string, SqlValue>;
export {};
//# sourceMappingURL=shred_columns.d.ts.map