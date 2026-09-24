/**
 * Turns table rows into a read's value: a list, a list in id order, a record keyed by id, or groups.
 *
 * The shapes are methods on the query's result, because the query already knows what they need, such as which column
 * holds the id and which ids were asked for. Each shape returns the caller's `empty` when no rows are left, so an empty
 * result is always the same object.
 */
import { FindOpts, RowShape, RowTable } from '../table/types';
/** Columns whose value is always a string, so they can key a `Map` or `Record` directly. */
type StringColumn<Row> = {
    [K in keyof Row]-?: Row[K] extends string ? K : never;
}[keyof Row] & string;
/** A query's rows, with methods to shape them. */
export interface RowSet<Row extends RowShape> {
    /** The rows, for a value none of the shapes covers. */
    readonly rows: readonly Row[];
    /**
     * Maps each row with `toVm`, dropping rows it returns `undefined` for. Keeps the query's order; to sort, pass an
     * `orderBy` to the query.
     */
    map<T>(toVm: (row: Row) => T | undefined, empty: T[]): T[];
    /** Groups the rows by a column's value, each group in query order. */
    groupBy(column: StringColumn<Row>): Map<string, Row[]>;
}
/** The rows of an `in` query, with extra shapes based on the ids it asked for. */
export interface IdRowSet<Row extends RowShape> extends RowSet<Row> {
    /** Maps the rows with `toVm`, in the order the ids were given, which SQL `IN` doesn't keep. */
    ordered<T>(toVm: (row: Row) => T | undefined, empty: T[]): T[];
    /** Maps the rows with `toVm` into a record keyed by the query's column. With duplicate keys, the last row wins. */
    indexed<T>(toVm: (row: Row) => T | undefined, empty: Record<string, T>): Record<string, T>;
    /** Groups the rows by the query's column, each group in query order. */
    grouped(): Map<string, Row[]>;
}
/** Queries a table and shapes the result in one expression. Created by {@link rowsOf}. */
export interface RowReader<Row extends RowShape> {
    /** The rows matching `filter`, in storage order unless `opts` sorts them. */
    where(filter: Partial<Row>, opts?: FindOpts<Row>): RowSet<Row>;
    /**
     * The rows matching `filter` whose `column` is one of `values`, which can be shaped in `values` order or keyed by
     * `column`.
     */
    in(filter: Partial<Row>, column: StringColumn<Row>, values: readonly string[]): IdRowSet<Row>;
    /** Rows from elsewhere, such as a SQL query, with the same shapes. */
    given(rows: readonly Row[]): RowSet<Row>;
}
/** Creates a {@link RowReader} for a table, which a hydration uses in place of the table itself. */
export declare function rowsOf<Row extends RowShape>(table: RowTable<Row>): RowReader<Row>;
export {};
//# sourceMappingURL=row_shaping.d.ts.map