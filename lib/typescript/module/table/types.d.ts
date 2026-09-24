/**
 * The row table: the interface a store reads and writes its rows through. A store keeps its data as rows in one SQLite
 * table, and every row table works the same way over any SQLite connection (the device's, or sql.js on web and in
 * tests).
 */
import type { WriteResult } from './change_set';
/** A value one SQLite column can hold in a row table: a string, a number, or null. Booleans are stored as 0 or 1. */
export type SqlValue = string | number | null;
/**
 * One row of a row table, as an object from column name to value. A column set to `undefined` is written as null, so a
 * row builder can leave a column out, such as a column one category of stat never fills.
 */
export type RowShape = Record<string, SqlValue | undefined>;
/**
 * The SQLite type of a column in a row table. These three cover everything a row holds: text is `TEXT`, whole numbers
 * and booleans (as 0 or 1) are `INTEGER`, other numbers are `REAL`, and anything structured, such as a list, is `TEXT`
 * holding its JSON.
 */
export type ColumnType = 'TEXT' | 'INTEGER' | 'REAL';
/** The declaration of one column of a row table: its SQLite type, and whether it may hold null. */
export interface ColumnDef {
    /**
     * The column's SQLite type: `TEXT` for strings and JSON, `INTEGER` for whole numbers and booleans (0 or 1), `REAL`
     * for other numbers. Changing it drops and rebuilds the table on the next launch.
     */
    type: ColumnType;
    /**
     * Declares the column `NOT NULL`, so SQLite rejects any write of a row that leaves it null, and the write fails. The
     * same check runs in tests (sql.js is SQLite too), so a row builder that misses the column fails in a test the way it
     * would on a device.
     */
    notNull?: boolean;
}
/**
 * A secondary index on a row table: a SQLite index over some of its columns, which lets a read that filters on those
 * columns find its rows without scanning the whole table. Declare one for each column combination reads filter on
 * that the primary key doesn't already start with, such as `['league', 'team']` for reading a team's players.
 */
export interface IndexDef<Row extends RowShape> {
    /** The index's SQLite name. It must be unique across the database. */
    name: string;
    /**
     * The columns the index covers, in order. A read can use the index when it filters on a prefix of this list: an index
     * on `['league', 'team']` serves a filter on `league`, and one on `league` and `team`, but not one on `team` alone.
     */
    columns: ReadonlyArray<keyof Row & string>;
}
/**
 * Where a row table keeps each partition's ETag: a small side table with one row per partition. A partition is the set
 * of rows one fetch returns and replaces. When a fetch's response carries an ETag, it is stored here, and the next
 * fetch of that partition sends it as `If-None-Match`; if the server answers 304 Not Modified, the partition's rows are
 * kept as they are and nothing is parsed or written.
 */
export interface MetaDef<Row extends RowShape> {
    /** The SQLite name of the side table, such as `player_meta`. */
    table: string;
    /**
     * The row table's columns that identify a partition, which are the side table's key: one ETag is stored per
     * combination of their values. These must be the columns the store's partition `where` sets, such as `['league']` for
     * a store whose partition is every player in one league.
     */
    keyColumns: ReadonlyArray<keyof Row & string>;
    /** The side table's column that holds the ETag string. */
    column: string;
}
/**
 * The declaration of a row table: the SQLite table a store keeps its rows in, its columns, its primary key, the column
 * its changes are tracked by (`unit`), its indexes, and where it keeps ETags.
 *
 * The table is created from this on the first launch, and each launch compares it with the table on disk. A change
 * that only adds nullable columns adds them in place and keeps the rows. Any other change (a column removed, retyped
 * or made `NOT NULL`, or a different key, index or ETag table) drops the table and builds it again empty, so the store
 * fetches its rows again.
 */
export interface RowTableSchema<Row extends RowShape> {
    /** The SQLite table's name, such as `players`. Renaming it creates a new, empty table. */
    table: string;
    /**
     * Every column of the table, by name, with its SQLite type and whether it may be null. The order of the keys is the
     * column order of the `CREATE TABLE` and of every `INSERT`.
     */
    columns: {
        [K in keyof Row]: ColumnDef;
    };
    /**
     * The columns whose values together identify one row, such as `['league', 'player_id']`. A table holds at most one
     * row per combination, and writing a row whose key already exists replaces that row.
     *
     * A write that replaces a partition matches each incoming row to the stored row with the same key, to find which
     * rows were added, changed or removed. `upsert`, which merges rows in without replacing the partition, needs a
     * primary key to match on.
     *
     * Use `[]` for a table whose rows have no identity of their own and can repeat, such as one a fetch refills whole;
     * its writes compare each unit's rows as a set instead of row by row, and it can't be upserted into.
     */
    primaryKey: ReadonlyArray<keyof Row & string>;
    /**
     * The column that divides each partition into units. A unit is all the rows in one partition that share a value in
     * this column: with `unit: 'player_id'`, player 4046's rows in the week 3 partition are one unit (one row or
     * several), and the same player in the week 4 partition is a different unit. Choose the id that reads look things up
     * by.
     *
     * The unit is how finely the kernel tracks change. Every write compares its rows with the stored ones, and collects
     * the unit value of each row that was added, changed or removed: that set is the write's change set. The write
     * replaces the rows of each unit in the set with the unit's new rows, deleting a unit that's no longer there, and
     * then bumps the partition's version and the version of each changed unit.
     *
     * Reads use the same division. A read that asks for particular units (through a projection's `one` or `byIds`, or a
     * `byUnit` memo) depends on just those units, and recomputes only when a write changes one of them. A read that looks
     * at the whole partition (scanning the table, or a projection's `all` or `where`) depends on the partition, and
     * recomputes after any write that changes it. Either way, the component re-renders only if the recomputed value
     * differs. Projections likewise build one view model per unit, and rebuild only the units a write changed.
     */
    unit: keyof Row & string;
    /**
     * The table's secondary indexes: SQLite indexes over the column combinations reads filter on, beyond the primary key.
     * Adding, removing or changing one drops and rebuilds the table on the next launch.
     */
    indexes?: ReadonlyArray<IndexDef<Row>>;
    /**
     * The side table each partition's ETag is kept in. With it, a fetch sends the stored ETag as `If-None-Match` and a
     * 304 response leaves the partition's rows as they are, so an unchanged partition costs no parsing and no writes.
     * Without it, every fetch downloads and writes the full body.
     */
    meta?: MetaDef<Row>;
    /**
     * Marks a table that receives rows from socket pushes that no fetch returns. It only changes reporting: a schema
     * change that drops and rebuilds this table loses those pushed rows until the next push brings them back, so the
     * rebuild is reported as a sampled notice.
     */
    pushFed?: boolean;
    /**
     * A number that is part of the table's schema stamp. Changing it drops and rebuilds the table on the next launch, as
     * any schema change does, and the store fetches its rows again. Bump it for a change the schema can't show, such as a
     * row builder that now computes a column differently, where the rows already stored would otherwise keep the old
     * values.
     */
    rebuildVersion?: number;
}
/** Options for {@link RowTable.find} beyond which rows to read. */
export interface FindOpts<Row extends RowShape> {
    /**
     * A column to sort the returned rows by, ascending. The sort runs in JS after the rows are read, the same on every
     * platform. Numbers sort numerically; everything else is compared as a string, by character code, so uppercase
     * letters sort before lowercase ones.
     */
    orderBy?: keyof Row & string;
}
/**
 * A store's rows in one SQLite table, and the only way the store reads and writes them. The table is divided into
 * partitions: a partition is the set of rows one fetch returns and replaces, picked out by column values (a `where`,
 * such as `{ league: 'nfl' }`). Each partition is divided into units: a unit is all the rows in the partition that
 * share a value in the schema's `unit` column, such as one player's rows.
 *
 * Every write compares its rows with the stored ones and returns its change set: the unit value of each row that was
 * added, changed or removed. A write whose rows match what the table holds returns an empty set. The table doesn't
 * notify readers itself: the code that calls the write bumps the partition's version with the change set, which is
 * what re-renders the readers of those units.
 */
export interface RowTable<Row extends RowShape> {
    /**
     * Creates the table, its indexes and its ETag table if they don't exist, and brings an older table on disk up to date
     * with the schema: added nullable columns are added in place, and any other change drops and rebuilds the table.
     * Must run before any other method.
     */
    init(): void;
    /** The columns whose values together identify one row, from the schema; `[]` for a table whose rows can repeat. */
    readonly primaryKey: ReadonlyArray<keyof Row & string>;
    /**
     * The schema's unit column: the column whose value says which thing a row belongs to, such as `player_id`. Writes
     * report their changes as the values of this column they changed, and view models are built one per value.
     */
    readonly unit: keyof Row & string;
    /**
     *    * Adds `rows`, replacing any stored row with the same primary key, as a socket push wants. Unlike a partition
     * replace, it removes nothing. Requires a primary key.
     *
     * Returns the unit values of the rows that were new or different, and the number of rows given. Writes in chunks, one
     * transaction each, and gives the JS thread back between chunks.
     */
    upsert(rows: readonly Row[], opts?: {
        /** How many rows to write per transaction; 250 by default, which keeps each transaction shorter than a frame. */
        chunk?: number;
    }): Promise<WriteResult>;
    /**
     *    * Replaces the rows matching `where` with exactly `rows`, synchronously, so 300 rows can become 3, or none. Every
     * row in `rows` must itself match `where` (checked in dev), or the next replace of that partition wouldn't delete it.
     *
     * Returns the unit values that were added, removed or changed, and the number of rows given.
     */
    overwrite(where: Partial<Row>, rows: readonly Row[]): WriteResult;
    /**
     * Replaces the rows matching `where` with the rows in a JSON response body, the same way {@link RowTable.overwrite}
     * does. When the connection and the store support it, the native shredder parses the body and writes the rows in
     * C++, so no JS objects are built for them; otherwise `parseRows` builds them in JS.
     *
     * Returns the unit values that were added, removed or changed, and the number of rows written.
     */
    shred(where: Partial<Row>, rawJson: string, parseRows: (rawJson: string) => Row[]): Promise<WriteResult>;
    /** The first stored row whose columns equal the values in `where`, or `undefined` if none does. */
    getOne(where: Partial<Row>): Row | undefined;
    /**
     * Every stored row whose columns equal the values in `where` (a `null` value matches a null column), in storage order
     * unless `opts.orderBy` names a column to sort by.
     */
    find(where: Partial<Row>, opts?: FindOpts<Row>): Row[];
    /**
     * Every stored row whose columns equal the values in `where` and whose `column` is one of `values`, such as the rows
     * for a list of player ids. Rows come back in storage order, not in the order of `values`.
     */
    findIn(where: Partial<Row>, column: keyof Row & string, values: readonly string[], opts?: {
        /** How many values to put in each `IN (…)` query; 900 by default, below SQLite's limit of 999 parameters. */
        chunk?: number;
    }): Row[];
    /**
     * Whether any stored row's columns equal the values in `where`. The answer for each `where` is remembered, and
     * writes update or discard what they could have changed, so repeated checks don't query SQLite.
     */
    has(where: Partial<Row>): boolean;
    /**
     * The distinct values of the unit column among the rows matching `where`, such as every `player_id` in a league,
     * without reading the rows themselves. A projection uses it to learn which units exist before building view models
     * only for the ones it hasn't built yet.
     */
    unitsWhere(where: Partial<Row>): string[];
    /**
     * The ETag stored for the partition that `where` names (by the schema's `meta.keyColumns`), or `undefined` if none is
     * stored or the schema declares no `meta`.
     */
    getMeta(where: Partial<Row>): string | undefined;
    /**
     * Stores the ETag for the partition that `where` names (by the schema's `meta.keyColumns`), or clears it when `value`
     * is `undefined`. Does nothing if the schema declares no `meta`.
     */
    setMeta(where: Partial<Row>, value: string | undefined): void;
}
/** A schema's column names in the order they are declared, which is the column order of every `INSERT`. */
export declare function columnNames<Row extends RowShape>(schema: RowTableSchema<Row>): Array<keyof Row & string>;
//# sourceMappingURL=types.d.ts.map