/**
 * Shapers that turn a partition's rows into a read's value: a list, an id-ordered list, a keyed record, or groups.
 * Each hands back the caller's stable `empty` when nothing survives, so an empty result keeps one identity. Their
 * mappers are `NoInfer`, since inferring `Row` from a mapper that takes `Row | undefined` collapses `keyof Row`.
 */
import { RowShape } from '../table/types';
/** Columns whose value is always a string, so they can key a `Map` or `Record` directly. */
type StringColumn<Row> = {
    [K in keyof Row]-?: Row[K] extends string ? K : never;
}[keyof Row] & string;
/**
 * The plain shape, and the one a hydration reaches for unless it needs another: every row through the mapper, dropping
 * the ones it turns down. The order is the query's, so a read that owes its caller an order asks the query for it.
 */
export declare function mapRows<Row, T>(rows: readonly Row[], toVm: (row: NoInfer<Row>) => T | undefined, empty: T[]): T[];
/** The rows in the order `ids` asked for, which SQL `IN` and `findIn`'s chunking both scramble. */
export declare function orderedByIds<Row extends RowShape, T>(rows: readonly Row[], idColumn: StringColumn<Row>, ids: readonly string[], toVm: (row: NoInfer<Row>) => T | undefined, empty: T[]): T[];
/** On a duplicate key, the last row wins. */
export declare function indexRowsBy<Row extends RowShape, T>(rows: readonly Row[], column: StringColumn<Row>, toVm: (row: NoInfer<Row>) => T | undefined, empty: Record<string, T>): Record<string, T>;
/** Each group is in the order the rows arrived. */
export declare function groupRowsBy<Row extends RowShape>(rows: readonly Row[], column: StringColumn<Row>): Map<string, Row[]>;
export {};
//# sourceMappingURL=row_shaping.d.ts.map