/** The `where` and ordering predicates the two row-table backends share: SQL on SQLite, the same rules in JS. */
import { RowShape, RowTableSchema, SqlValue } from './types';
/** Builds a row filter's `WHERE` clause and its binds; an absent value becomes `IS NULL`, the spelling SQL matches on. */
export declare function whereClause(where: Partial<RowShape>): {
    sql: string;
    params: SqlValue[];
};
/** The memory backend's half of {@link whereClause}: whether one row satisfies `where`. */
export declare function matchesWhere<Row extends RowShape>(row: Row, where: Partial<Row>): boolean;
/** Dev-only: the declared unit has to be one of the table's columns, since every write groups its rows by it. */
export declare function assertUnitColumn<Row extends RowShape>(schema: RowTableSchema<Row>): void;
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