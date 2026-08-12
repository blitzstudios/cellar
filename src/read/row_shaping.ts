/**
 * Shapers that turn a partition's rows into a read's value: a list, an id-ordered list, a keyed record, or groups.
 * Each hands back the caller's stable `empty` when nothing survives, so an empty result keeps one identity. Their
 * mappers are `NoInfer`, since inferring `Row` from a mapper that takes `Row | undefined` collapses `keyof Row`.
 */

import { RowShape } from '../table/types';

/** Columns whose value is always a string, so they can key a `Map` or `Record` directly. */
type StringColumn<Row> = { [K in keyof Row]-?: Row[K] extends string ? K : never }[keyof Row] & string;

/**
 * The plain shape, and the one a hydration reaches for unless it needs another: every row through the mapper, dropping
 * the ones it turns down. The order is the query's, so a read that owes its caller an order asks the query for it.
 */
export function mapRows<Row, T>(rows: readonly Row[], toVm: (row: NoInfer<Row>) => T | undefined, empty: T[]): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const vm = toVm(row);
    if (vm) out.push(vm);
  }
  return out.length ? out : empty;
}

/** The rows in the order `ids` asked for, which SQL `IN` and `findIn`'s chunking both scramble. */
export function orderedByIds<Row extends RowShape, T>(
  rows: readonly Row[],
  idColumn: StringColumn<Row>,
  ids: readonly string[],
  toVm: (row: NoInfer<Row>) => T | undefined,
  empty: T[],
): T[] {
  const byId = new Map<string, Row>();
  for (const row of rows) byId.set(row[idColumn] as string, row);
  const out: T[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    const vm = row ? toVm(row) : undefined;
    if (vm) out.push(vm);
  }
  return out.length ? out : empty;
}

/** On a duplicate key, the last row wins. */
export function indexRowsBy<Row extends RowShape, T>(
  rows: readonly Row[],
  column: StringColumn<Row>,
  toVm: (row: NoInfer<Row>) => T | undefined,
  empty: Record<string, T>,
): Record<string, T> {
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
}

/** Each group is in the order the rows arrived. */
export function groupRowsBy<Row extends RowShape>(rows: readonly Row[], column: StringColumn<Row>): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const value = row[column] as string;
    const list = grouped.get(value);
    if (list) list.push(row);
    else grouped.set(value, [row]);
  }
  return grouped;
}
