/**
 * Turning a partition's rows into a read's value: a list, an id-ordered list, a keyed record, or groups.
 *
 * The shaping hangs off the query rather than standing beside it, because everything a shaper needs — which column
 * holds the id, which ids were asked for — is something the query was already told. A hydration that says it twice can
 * say it two different ways, and the shapes it hands back would disagree with the rows it holds.
 *
 * Each shape hands back the caller's stable `empty` when nothing survives, so an empty result keeps one identity and
 * the read's bail-out holds. A row set costs one object per query, which is noise beside the query's own row array,
 * and a hydration only reaches one on a cache miss.
 */

import { FindOpts, RowShape, RowTable } from '../table/types';

/** Columns whose value is always a string, so they can key a `Map` or `Record` directly. */
type StringColumn<Row> = { [K in keyof Row]-?: Row[K] extends string ? K : never }[keyof Row] & string;

/** Rows in hand, and the shapes any set of them can take. */
export interface RowSet<Row extends RowShape> {
  /** The rows themselves, for a hydration deriving something no shape here covers. */
  readonly rows: readonly Row[];
  /**
   * The plain shape, and the one a hydration reaches for unless it needs another: every row through the mapper,
   * dropping the ones it turns down. The order is the query's, so a read that owes its caller an order asks the query.
   */
  map<T>(toVm: (row: Row) => T | undefined, empty: T[]): T[];
  /** Each group is in the order the rows arrived. */
  groupBy(column: StringColumn<Row>): Map<string, Row[]>;
}

/** The rows an `in` query matched, which can additionally be shaped around the ids it named. */
export interface IdRowSet<Row extends RowShape> extends RowSet<Row> {
  /** The rows in the order the ids were named, which SQL `IN` and `findIn`'s chunking both scramble. */
  ordered<T>(toVm: (row: Row) => T | undefined, empty: T[]): T[];
  /** Keyed by the column the query named. On a duplicate key, the last row wins. */
  indexed<T>(toVm: (row: Row) => T | undefined, empty: Record<string, T>): Record<string, T>;
  /** Grouped by the column the query named, each group in the order the rows arrived. */
  grouped(): Map<string, Row[]>;
}

/** A table's rows, queried and shaped in one expression. Built once per hydration by {@link rowsOf}. */
export interface RowReader<Row extends RowShape> {
  /** The rows matching a filter, `opts` ordering them where storage order will not do. */
  where(filter: Partial<Row>, opts?: FindOpts<Row>): RowSet<Row>;
  /** The rows whose `column` is one of `values`, shapeable in that order or keyed by that column. */
  in(filter: Partial<Row>, column: StringColumn<Row>, values: readonly string[]): IdRowSet<Row>;
  /** Rows from somewhere other than a `find` — a native filtered read, or a set already in hand — shaped the same way. */
  given(rows: readonly Row[]): RowSet<Row>;
}

function groupRows<Row extends RowShape>(rows: readonly Row[], column: StringColumn<Row>): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const value = row[column] as string;
    const list = grouped.get(value);
    if (list) list.push(row);
    else grouped.set(value, [row]);
  }
  return grouped;
}

function rowSet<Row extends RowShape>(rows: readonly Row[]): RowSet<Row> {
  return {
    rows,
    map<T>(toVm: (row: Row) => T | undefined, empty: T[]): T[] {
      const out: T[] = [];
      for (const row of rows) {
        const vm = toVm(row);
        if (vm) out.push(vm);
      }
      return out.length ? out : empty;
    },
    groupBy: (column) => groupRows(rows, column),
  };
}

function idRowSet<Row extends RowShape>(rows: readonly Row[], column: StringColumn<Row>, ids: readonly string[]): IdRowSet<Row> {
  return {
    ...rowSet(rows),
    ordered<T>(toVm: (row: Row) => T | undefined, empty: T[]): T[] {
      const byId = new Map<string, Row>();
      for (const row of rows) byId.set(row[column] as string, row);
      const out: T[] = [];
      for (const id of ids) {
        const row = byId.get(id);
        const vm = row ? toVm(row) : undefined;
        if (vm) out.push(vm);
      }
      return out.length ? out : empty;
    },
    indexed<T>(toVm: (row: Row) => T | undefined, empty: Record<string, T>): Record<string, T> {
      const out: Record<string, T> = {};
      let found = false;
      for (const row of rows) {
        const vm = toVm(row);
        if (vm) {
          out[row[column] as string] = vm;
          found = true;
        }
      }
      return found ? out : empty;
    },
    grouped: () => groupRows(rows, column),
  };
}

/** Binds the shapes above to one table, which is what a hydration holds instead of the table itself. */
export function rowsOf<Row extends RowShape>(table: RowTable<Row>): RowReader<Row> {
  return {
    where: (filter, opts) => rowSet(table.find(filter, opts)),
    in: (filter, column, values) => idRowSet(table.findIn(filter, column, values), column, values),
    given: (rows) => rowSet(rows),
  };
}
