/**
 * The in-memory backend's half of the unit diff SQLite runs in `sqlite.ts`: which units a write changed, decided by
 * comparing every column of the rows it was handed with the rows already held.
 */

import { RowShape } from './types';

/**
 * A row's content as one string, for comparing two rows column by column. `undefined` and `null` are the same value,
 * as they are once SQLite binds them, and a number never equals the string spelling it, as in SQLite.
 */
export function rowSignature<Row extends RowShape>(row: Row, columns: readonly (keyof Row & string)[]): string {
  let signature = '';
  for (const column of columns) {
    const value = row[column];
    signature += value == null ? '\u0000' : typeof value === 'number' ? `n${value}` : `s${value}`;
    signature += '\u0001';
  }
  return signature;
}

/** Each unit's rows, as sorted signatures joined into one string: equal exactly when the unit holds the same rows. */
function unitContents<Row extends RowShape>(rows: Iterable<Row>, unit: keyof Row & string, columns: readonly (keyof Row & string)[]): Map<string, string> {
  const byUnit = new Map<string, string[]>();
  for (const row of rows) {
    const id = String(row[unit]);
    let list = byUnit.get(id);
    if (!list) byUnit.set(id, (list = []));
    list.push(rowSignature(row, columns));
  }
  const out = new Map<string, string>();
  for (const [id, list] of byUnit) out.set(id, list.sort().join('\u0002'));
  return out;
}

/**
 * The units whose rows differ between `before` and `after`: added, removed, or holding different rows. A unit's rows
 * are compared as a multiset, so a table without a primary key that holds duplicate rows is compared correctly too.
 */
export function changedUnits<Row extends RowShape>(
  before: Iterable<Row>,
  after: Iterable<Row>,
  unit: keyof Row & string,
  columns: readonly (keyof Row & string)[],
): Set<string> {
  const old = unitContents(before, unit, columns);
  const next = unitContents(after, unit, columns);
  const changed = new Set<string>();
  for (const [id, contents] of next) if (old.get(id) !== contents) changed.add(id);
  for (const id of old.keys()) if (!next.has(id)) changed.add(id);
  return changed;
}
