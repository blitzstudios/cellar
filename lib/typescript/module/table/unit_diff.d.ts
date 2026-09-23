/**
 * The in-memory backend's half of the unit diff SQLite runs in `sqlite.ts`: which units a write changed, decided by
 * comparing every column of the rows it was handed with the rows already held.
 */
import { RowShape } from './types';
/**
 * A row's content as one string, for comparing two rows column by column. `undefined` and `null` are the same value,
 * as they are once SQLite binds them, and a number never equals the string spelling it, as in SQLite.
 */
export declare function rowSignature<Row extends RowShape>(row: Row, columns: readonly (keyof Row & string)[]): string;
/**
 * The units whose rows differ between `before` and `after`: added, removed, or holding different rows. A unit's rows
 * are compared as a multiset, so a table without a primary key that holds duplicate rows is compared correctly too.
 */
export declare function changedUnits<Row extends RowShape>(before: Iterable<Row>, after: Iterable<Row>, unit: keyof Row & string, columns: readonly (keyof Row & string)[]): Set<string>;
//# sourceMappingURL=unit_diff.d.ts.map