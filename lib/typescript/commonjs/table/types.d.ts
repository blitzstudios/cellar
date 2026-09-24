/** The row table interface: what a store reads and writes its rows through, over any SQLite connection. */
import type { WriteResult } from './change_set';
/** A value a SQLite column can hold here: text, a number, or null. */
export type SqlValue = string | number | null;
/**
 * One row, as column name to value. `undefined` binds as null, which covers a generated column a category leaves blank.
 */
export type RowShape = Record<string, SqlValue | undefined>;
/**
 * The type a column is declared as. These three are all a row can hold: a flag is an `INTEGER` of 0 or 1, and anything
 * structured is `TEXT` holding its JSON.
 */
export type ColumnType = 'TEXT' | 'INTEGER' | 'REAL';
/** One column of a row table: its type, and whether it may be null. */
export interface ColumnDef {
    /** The column's SQLite type. */
    type: ColumnType;
    /** Rejects a row that leaves this column null. SQLite enforces it, so a test fails the same way the device does. */
    notNull?: boolean;
}
/** A secondary index over columns a read filters on. */
export interface IndexDef<Row extends RowShape> {
    /** The index's name, which `init` and a bulk write create and drop it by. */
    name: string;
    /** The indexed columns, in index order. */
    columns: ReadonlyArray<keyof Row & string>;
}
/** The side table that stores each partition's ETag, so a refetch can send `If-None-Match` and get a 304 back. */
export interface MetaDef<Row extends RowShape> {
    /** The side table's name. */
    table: string;
    /** The row columns that identify a partition, which key the side table. */
    keyColumns: ReadonlyArray<keyof Row & string>;
    /** The column the ETag is stored in. */
    column: string;
}
/** Everything a row table is built from: its name, columns, key, unit, indexes and ETag table. */
export interface RowTableSchema<Row extends RowShape> {
    /** The SQLite table's name. */
    table: string;
    /** Every column, keyed by name. The key order is the `INSERT` bind order. */
    columns: {
        [K in keyof Row]: ColumnDef;
    };
    /**
     * The columns that identify a row. A write with a row whose key is already there replaces that row. `[]` for a
     * table that holds duplicate rows, such as one refilled wholesale by each fetch.
     */
    primaryKey: ReadonlyArray<keyof Row & string>;
    /**
     * The column that groups rows into the things a screen shows — `player_id` groups a player's rows, `team` a team's.
     * A write reports which values of it changed, and a read of one value re-renders only when that value's rows change.
     * One value can cover many rows: a player's games in a week are several rows and one unit.
     */
    unit: keyof Row & string;
    /** Secondary indexes for the columns reads filter on. */
    indexes?: ReadonlyArray<IndexDef<Row>>;
    /** Where each partition's ETag is stored; omit it and fetches never send `If-None-Match`. */
    meta?: MetaDef<Row>;
    /**
     * Marks a table that pushes can write rows into that no fetch returns. A schema change that rebuilds such a table
     * loses those rows, so the rebuild is reported.
     */
    pushFed?: boolean;
    /**
     * Bump to drop and rebuild the table on the next launch. For a change the schema itself does not show, such as a
     * row builder that now fills a column differently.
     */
    rebuildVersion?: number;
}
/** Options for {@link RowTable.find} beyond its row filter. */
export interface FindOpts<Row extends RowShape> {
    /**
     * A column to sort the rows by. Sorted in JS after the read, comparing strings by code unit, so text sorts by ASCII.
     */
    orderBy?: keyof Row & string;
}
/**
 * A store's rows in one SQLite table: writes that report which units changed, reads over a column filter, and each
 * partition's ETag.
 *
 * Every write compares what it was handed with what the table holds and rewrites only the units that differ, so a
 * write whose payload matches the table changes nothing and reports an empty change set. Nothing here bumps a version;
 * the partition's ingest does that with the units a write reports.
 */
export interface RowTable<Row extends RowShape> {
    /** Creates the table, its indexes and its ETag table, migrating an older database whose schema differs. */
    init(): void;
    /** The columns that identify a row, from the schema; `[]` for a table that declares none. */
    readonly primaryKey: ReadonlyArray<keyof Row & string>;
    /** The schema's unit column: what a write reports its changes by and a view model is built per. */
    readonly unit: keyof Row & string;
    /**
     * Adds or replaces `rows` by primary key and leaves every other row alone, which is what a socket delta wants.
     * Needs a primary key. Reports the units whose rows actually changed.
     */
    upsert(rows: readonly Row[], opts?: {
        /** Rows per transaction; 250 by default, which keeps each one under a frame. */
        chunk?: number;
    }): Promise<WriteResult>;
    /**
     * Replaces the rows matching `where` with exactly `rows`, so a slice of 300 can become a slice of 3, or of none.
     * Every row must match `where`, or it lands where no later write to the slice can reach it. Reports the units that
     * were added, removed, or changed.
     */
    overwrite(where: Partial<Row>, rows: readonly Row[]): WriteResult;
    /**
     * The same replacement as {@link RowTable.overwrite}, from a response body not yet parsed: shredded in C++ when the
     * connection and the store's shred spec allow it, and through `parseRows` when they don't.
     */
    shred(where: Partial<Row>, rawJson: string, parseRows: (rawJson: string) => Row[]): Promise<WriteResult>;
    /** The first row matching `where`, or `undefined`. */
    getOne(where: Partial<Row>): Row | undefined;
    /** Every row matching `where`, in storage order unless `opts.orderBy` names a column. */
    find(where: Partial<Row>, opts?: FindOpts<Row>): Row[];
    /**
     * The rows matching `where` whose `column` is one of `values`, in storage order; the caller reorders them to match
     * `values` if it needs to.
     */
    findIn(where: Partial<Row>, column: keyof Row & string, values: readonly string[], opts?: {
        /** Values per `IN (…)` query; 900 by default, under SQLite's bind limit. */
        chunk?: number;
    }): Row[];
    /** Whether any row matches `where`. */
    has(where: Partial<Row>): boolean;
    /**
     * The distinct unit values among the rows matching `where`, in storage order, without reading the rows: how a
     * projection learns which units a filter holds before building only the ones it has not built yet.
     */
    unitsWhere(where: Partial<Row>): string[];
    /** The ETag stored for the partition `where` names, or `undefined`. */
    getMeta(where: Partial<Row>): string | undefined;
    /** Stores the ETag for the partition `where` names; `undefined` clears it. */
    setMeta(where: Partial<Row>, value: string | undefined): void;
}
/** A schema's column names in declaration order, which is the order an `INSERT` binds them. */
export declare function columnNames<Row extends RowShape>(schema: RowTableSchema<Row>): Array<keyof Row & string>;
//# sourceMappingURL=types.d.ts.map