/** The row table interface both backends implement: SQLite on mobile, a `Map` on web and in tests. */

export type SqlValue = string | number | null;

/** One row's column values; `undefined` binds as null, which covers a generated column a category leaves blank. */
export type RowShape = Record<string, SqlValue | undefined>;

/**
 * The storage classes a column can be declared as, and the whole of what a row can hold: a flag is an `INTEGER` of 0
 * or 1, and anything structured is `TEXT` holding its JSON.
 */
export type ColumnType = 'TEXT' | 'INTEGER' | 'REAL';

/**
 * One column as SQLite will create it. `notNull` is enforced by the database and not by the in-memory backend, so a
 * row the constraint would reject on device inserts happily in a test.
 */
export interface ColumnDef {
  type: ColumnType;
  notNull?: boolean;
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
  columns: { [K in keyof Row]: ColumnDef };
  /** `[]` for a snapshot table that legitimately holds duplicate rows, such as one refilled wholesale by each fetch. */
  primaryKey: ReadonlyArray<keyof Row & string>;
  indexes?: ReadonlyArray<IndexDef<Row>>;
  meta?: MetaDef<Row>;
  pushFed?: boolean;
  rebuildVersion?: number;
}

/** What a `find` takes past its row filter, for a hydration that wants its rows in a column's order rather than in storage order. */
export interface FindOpts<Row extends RowShape> {
  /** Sorted in JS on both backends, and a string compares by code unit, so a display name sorts by ASCII. */
  orderBy?: keyof Row & string;
}

/**
 * The whole contract a store has with its rows — three writes, reads over a `where`, and the ETag pair — answered
 * identically by SQLite and by `Map`s. Nothing here touches a version atom, so a write made straight against the table
 * repaints nothing; a hydration calls these reads directly, but a write belongs to a partition's ingest.
 */
export interface RowTable<Row extends RowShape> {
  init(): void;
  /**
   * The schema's primary key, so a caller holding only the table can work out what identifies a row without being
   * handed the schema too. `[]` for a table that declares none. A row projection reads it to derive which column
   * identifies a row inside one partition.
   */
  readonly primaryKey: ReadonlyArray<keyof Row & string>;
  /**
   * Merges `rows` in by primary key, leaving every other row alone, which is what a socket delta wants. Requires a
   * primary key: without one there is nothing to replace on, and each call appends duplicates instead.
   */
  upsert(rows: readonly Row[], opts?: { chunk?: number }): Promise<number>;
  /**
   * Makes the rows matching `where` be exactly `rows`: one transaction that deletes everything the filter matches
   * and inserts what you pass, so a slice of 300 can become a slice of 3, or of none. Every row must satisfy
   * `where`, since one that doesn't lands where no later write to the slice can reach it.
   */
  overwrite(where: Partial<Row>, rows: readonly Row[]): number;
  /**
   * The same replacement from an undecoded response body: shredded in C++ when the connection and the shred spec
   * allow, and through `parseRows` when they don't.
   */
  shred(where: Partial<Row>, rawJson: string, parseRows: (rawJson: string) => Row[]): Promise<number>;
  getOne(where: Partial<Row>): Row | undefined;
  find(where: Partial<Row>, opts?: FindOpts<Row>): Row[];
  /** Returns matching rows in storage order; the caller reorders them to match `values`. */
  findIn(where: Partial<Row>, column: keyof Row & string, values: readonly string[], opts?: { chunk?: number }): Row[];
  has(where: Partial<Row>): boolean;
  /**
   * The content digest of each row matching `where`, keyed by `column`, without materializing the rows. Narrowed to
   * `values` when the caller already knows which rows it is asking about.
   *
   * This is what makes a version bump survivable. A bump invalidates every value derived from the partition, but it
   * says nothing about which rows moved; a digest does, so only those rows are read and only their values rebuilt.
   * SQLite concatenates the columns itself, so one short string per row crosses the bridge rather than every column
   * behind it. A row the filter does not match is absent rather than carrying an empty digest.
   */
  digests(where: Partial<Row>, column: keyof Row & string, values?: readonly string[]): Map<string, string>;
  getMeta(where: Partial<Row>): string | undefined;
  setMeta(where: Partial<Row>, value: string | undefined): void;
}

/** A schema's columns in declaration order, which is the order an `INSERT` binds them and the order the fingerprint hashes. */
export function columnNames<Row extends RowShape>(schema: RowTableSchema<Row>): Array<keyof Row & string> {
  return Object.keys(schema.columns) as Array<keyof Row & string>;
}
