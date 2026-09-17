/** The `where` and ordering predicates the two row-table backends share: SQL on SQLite, the same rules in JS. */
import { RowShape, RowTableSchema, SqlValue } from './types';
/**
 * Separates the columns of a digest. No column value can hold it, so two rows cannot digest alike by having their
 * values run together. SQLite spells the same character `char(1)`.
 */
export declare const DIGEST_SEP = "\u0001";
/** Stands for a row the slice does not hold, which is itself worth remembering so a bump does not re-ask for it. */
export declare const NO_ROW_DIGEST = "\0";
/**
 * The columns a digest covers: every one the schema declares, in declaration order.
 *
 * Deliberately not narrowed to the columns outside the caller's filter. A digest is compared against the one held
 * for the same row by a memo that several reads share, so it has to mean the same thing whichever read asked — and a
 * digest that skipped whatever the filter pinned would differ between a read filtered by team and one by id, leaving
 * that memo unable to hit.
 */
export declare function digestColumns<Row extends RowShape>(schema: RowTableSchema<Row>): Array<keyof Row & string>;
/**
 * The digest of one row, which is the `Map` backend's half of the SQL expression in `sqlite.ts`.
 *
 * Each backend is self-consistent, which is all a comparison needs. They can still spell a floating-point column
 * differently — SQLite writes a whole number as `1.0` where JS writes `1` — so a store that swaps from `Map`s to
 * SQLite partway through a session rebuilds its values once. That costs a rebuild, never a stale value.
 */
export declare function digestRow<Row extends RowShape>(row: Row, columns: readonly (keyof Row & string)[]): string;
/** Builds a row filter's `WHERE` clause and its binds; an absent value becomes `IS NULL`, the spelling SQL matches on. */
export declare function whereClause(where: Partial<RowShape>): {
    sql: string;
    params: SqlValue[];
};
/** The memory backend's half of {@link whereClause}: whether one row satisfies `where`. */
export declare function matchesWhere<Row extends RowShape>(row: Row, where: Partial<Row>): boolean;
/**
 * Dev-only: every row written under a filter must satisfy it. A row that doesn't lands outside the slice its own
 * write just cleared, where the next write to that slice cannot reach it and no `find` for it expects it.
 */
export declare function assertRowsMatchWhere<Row extends RowShape>(table: string, where: Partial<Row>, rows: readonly Row[]): void;
/**
 * The ordering behind `FindOpts.orderBy`, run in JS by both backends so an ordered `find` comes back in one sequence
 * whichever one served it. A column holding numbers sorts numerically, and everything else compares as a string.
 */
export declare function comparator<Row extends RowShape>(orderBy: keyof Row & string): (left: Row, right: Row) => number;
//# sourceMappingURL=query.d.ts.map