/** The row table interface both kinds implement: SQLite on mobile, a `Map` on web and in tests. */
import type { WriteResult } from './change_set';
export type SqlValue = string | number | null;
/** One row's column values; `undefined` binds as null, which covers a generated column a category leaves blank. */
export type RowShape = Record<string, SqlValue | undefined>;
/**
 * The storage classes a column can be declared as, and the whole of what a row can hold: a flag is an `INTEGER` of 0
 * or 1, and anything structured is `TEXT` holding its JSON.
 */
export type ColumnType = 'TEXT' | 'INTEGER' | 'REAL';
/**
 * One column as SQLite will create it. `notNull` is enforced by the database and not by the in-memory table, so a
 * row the constraint would reject on device inserts happily in a test.
 */
export interface ColumnDef {
    type: ColumnType;
    notNull?: boolean;
    /**
     * Read only by SQL the store writes itself — a score column a ranked scan sums, say — and never by a heap read. The
     * in-memory table neither stores nor compares it, so a store builds it only for a table whose `engine` is `sqlite`.
     */
    sqliteOnly?: boolean;
}
/** A secondary index over the columns a read filters on, named so `init` and a bulk write can create and drop it by name. */
export interface IndexDef<Row extends RowShape> {
    name: string;
    columns: ReadonlyArray<keyof Row & string>;
}
/** Etag side-table, keyed by the columns that address a partition. */
export interface MetaDef<Row extends RowShape> {
    table: string;
    keyColumns: ReadonlyArray<keyof Row & string>;
    column: string;
}
/** One row table's declaration: its columns in `INSERT` bind order, which is the `columns` object's key order. */
export interface RowTableSchema<Row extends RowShape> {
    table: string;
    columns: {
        [K in keyof Row]: ColumnDef;
    };
    /** `[]` for a snapshot table that legitimately holds duplicate rows, such as one refilled wholesale by each fetch. */
    primaryKey: ReadonlyArray<keyof Row & string>;
    /**
     * What a view model is about — a player, a team — and so the grain a write reports its changes in and a read
     * subscribes at. One unit may span many rows: a player's games in a week are several rows and one unit. A write
     * rewrites a changed unit whole and leaves an unchanged one untouched, and a reader of one unit wakes only when it
     * changes.
     */
    unit: keyof Row & string;
    indexes?: ReadonlyArray<IndexDef<Row>>;
    meta?: MetaDef<Row>;
    pushFed?: boolean;
    rebuildVersion?: number;
}
/** What a `find` takes past its row filter, for a hydration that wants its rows in a column's order rather than in storage order. */
export interface FindOpts<Row extends RowShape> {
    /** Sorted in JS on both kinds of table, and a string compares by code unit, so a display name sorts by ASCII. */
    orderBy?: keyof Row & string;
}
/**
 * The whole contract a store has with its rows — three writes, reads over a `where`, and the ETag pair — answered
 * identically by SQLite and by `Map`s. Nothing here touches a version atom: a write reports the units it changed, and
 * the partition's ingest is what bumps with them.
 *
 * Every write compares what it was handed with what the table holds and rewrites only the units that differ, so a
 * write whose payload matches the table changes nothing and reports an empty change set.
 */
export interface RowTable<Row extends RowShape> {
    /** Where the rows live, which decides whether a row needs its `sqliteOnly` columns built at all. */
    readonly engine: 'sqlite' | 'memory';
    init(): void;
    /**
     * The schema's primary key, so a caller holding only the table can work out what identifies a row without being
     * handed the schema too. `[]` for a table that declares none.
     */
    readonly primaryKey: ReadonlyArray<keyof Row & string>;
    /** The schema's unit: the column a write reports its changes by and a view model is built per. */
    readonly unit: keyof Row & string;
    /**
     * Merges `rows` in by primary key, leaving every other row alone, which is what a socket delta wants. Requires a
     * primary key: without one there is nothing to replace on. Reports the units of the rows that actually differed.
     */
    upsert(rows: readonly Row[], opts?: {
        chunk?: number;
    }): Promise<WriteResult>;
    /**
     * Makes the rows matching `where` be exactly `rows`, so a slice of 300 can become a slice of 3, or of none. Every row
     * must satisfy `where`, since one that doesn't lands where no later write to the slice can reach it. Reports the
     * units that were added, removed, or whose rows differ.
     */
    overwrite(where: Partial<Row>, rows: readonly Row[]): WriteResult;
    /**
     * The same replacement from an undecoded response body: shredded in C++ when the connection and the shred spec
     * allow, and through `parseRows` when they don't.
     */
    shred(where: Partial<Row>, rawJson: string, parseRows: (rawJson: string) => Row[]): Promise<WriteResult>;
    getOne(where: Partial<Row>): Row | undefined;
    find(where: Partial<Row>, opts?: FindOpts<Row>): Row[];
    /** Returns matching rows in storage order; the caller reorders them to match `values`. */
    findIn(where: Partial<Row>, column: keyof Row & string, values: readonly string[], opts?: {
        chunk?: number;
    }): Row[];
    has(where: Partial<Row>): boolean;
    /**
     * The distinct units among the rows matching `where`, in storage order, without the rows behind them: what a
     * projection asks to learn which units a filter holds before reading only the ones it has not built.
     */
    unitsWhere(where: Partial<Row>): string[];
    getMeta(where: Partial<Row>): string | undefined;
    setMeta(where: Partial<Row>, value: string | undefined): void;
}
/** A schema's columns in declaration order, which is the order an `INSERT` binds them and the order the fingerprint hashes. */
export declare function columnNames<Row extends RowShape>(schema: RowTableSchema<Row>): Array<keyof Row & string>;
/** The columns the in-memory table holds and compares: every one but those marked `sqliteOnly`. */
export declare function memoryColumns<Row extends RowShape>(schema: RowTableSchema<Row>): Array<keyof Row & string>;
//# sourceMappingURL=types.d.ts.map