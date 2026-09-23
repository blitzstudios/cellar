/** The row table held in JS `Map`s, which is the backend on web and in every test. */

import { cacheKeyOf } from '../args_key';
import { createPresence, whereMapKey } from './presence';
import { noteTableRead } from './read_coverage';
import { columnNames, FindOpts, RowShape, RowTable, RowTableSchema } from './types';
import { assertRowsMatchWhere, assertUnitColumn, comparator, matchesWhere } from './query';
import { NO_CHANGES, WriteResult } from './change_set';
import { changedUnits, rowSignature } from './unit_diff';

/**
 * The {@link RowTable} a store gets where the platform has no SQLite: the web build, every test, and the stretch before
 * a mobile store's connection is bound. Its rows sit on the JS heap, so it answers a read exactly as SQLite would and
 * saves none of the memory the off-heap design is for.
 */
export function createMemoryRowTable<Row extends RowShape>(schema: RowTableSchema<Row>): RowTable<Row> {
  if (__DEV__) assertUnitColumn(schema);
  const hasPk = schema.primaryKey.length > 0;
  const { unit } = schema;
  const cols = columnNames(schema);
  const byPk = new Map<string, Row>();
  const rowsList: Row[] = [];
  const presence = createPresence();
  const meta = new Map<string, string>();

  const pkOf = (row: Row): string => cacheKeyOf(schema.primaryKey.map((column) => String(row[column])));
  const allRows = (): Iterable<Row> => (hasPk ? byPk.values() : rowsList);
  const inUnits = (changed: ReadonlySet<string>) => (row: Row) => changed.has(String(row[unit]));

  function removeWhere(where: Partial<Row>, also: (row: Row) => boolean): void {
    if (hasPk) {
      for (const [key, row] of byPk) if (matchesWhere(row, where) && also(row)) byPk.delete(key);
    } else {
      for (let index = rowsList.length - 1; index >= 0; index -= 1) {
        if (matchesWhere(rowsList[index], where) && also(rowsList[index])) rowsList.splice(index, 1);
      }
    }
  }

  function insertRows(rows: Iterable<Row>): void {
    if (hasPk) {
      for (const row of rows) byPk.set(pkOf(row), row);
    } else {
      for (const row of rows) rowsList.push(row);
    }
  }

  /** Rewrites only the units whose rows differ, so an unchanged unit keeps the very row objects it held. */
  function overwriteWith(where: Partial<Row>, rows: readonly Row[]): WriteResult {
    if (__DEV__) assertRowsMatchWhere(schema.table, where, rows);
    const before: Row[] = [];
    for (const row of allRows()) if (matchesWhere(row, where)) before.push(row);
    const changed = changedUnits(before, rows, unit, cols);
    if (changed.size) {
      const changedRow = inUnits(changed);
      removeWhere(where, changedRow);
      insertRows(rows.filter(changedRow));
    }
    presence.afterDelete(where);
    return { changes: changed.size ? changed : NO_CHANGES, rows: rows.length };
  }

  return {
    primaryKey: schema.primaryKey,
    unit,

    init(): void {},

    async upsert(rows: readonly Row[]): Promise<WriteResult> {
      const changed = new Set<string>();
      const moved: Row[] = [];
      for (const row of rows) {
        const held = hasPk ? byPk.get(pkOf(row)) : undefined;
        if (held && rowSignature(held, cols) === rowSignature(row, cols)) continue;
        changed.add(String(row[unit]));
        moved.push(row);
      }
      insertRows(moved);
      if (moved.length) presence.afterInsert();
      return { changes: changed.size ? changed : NO_CHANGES, rows: rows.length };
    },

    overwrite(where: Partial<Row>, rows: readonly Row[]): WriteResult {
      return overwriteWith(where, rows);
    },

    async shred(where: Partial<Row>, rawJson: string, parseRows: (rawJson: string) => Row[]): Promise<WriteResult> {
      return overwriteWith(where, parseRows(rawJson));
    },

    getOne(where: Partial<Row>): Row | undefined {
      noteTableRead();
      for (const row of allRows()) if (matchesWhere(row, where)) return row;
      return undefined;
    },

    find(where: Partial<Row>, opts?: FindOpts<Row>): Row[] {
      noteTableRead();
      const out: Row[] = [];
      for (const row of allRows()) if (matchesWhere(row, where)) out.push(row);
      if (opts?.orderBy) out.sort(comparator<Row>(opts.orderBy));
      return out;
    },

    findIn(where: Partial<Row>, column: keyof Row & string, values: readonly string[], _opts?: { chunk?: number }): Row[] {
      noteTableRead();
      if (!values.length) return [];
      const wanted = new Set(values);
      const out: Row[] = [];
      for (const row of allRows()) {
        if (matchesWhere(row, where) && wanted.has(String(row[column]))) out.push(row);
      }
      return out;
    },

    has(where: Partial<Row>): boolean {
      noteTableRead();
      const cached = presence.get(where);
      if (cached !== undefined) return cached;
      let found = false;
      for (const row of allRows()) {
        if (matchesWhere(row, where)) {
          found = true;
          break;
        }
      }
      presence.observe(where, found);
      return found;
    },

    unitsWhere(where: Partial<Row>): string[] {
      noteTableRead();
      const seen = new Set<string>();
      for (const row of allRows()) if (matchesWhere(row, where)) seen.add(String(row[unit]));
      return [...seen];
    },

    getMeta(where: Partial<Row>): string | undefined {
      return meta.get(whereMapKey(where));
    },

    setMeta(where: Partial<Row>, value: string | undefined): void {
      if (value === undefined) meta.delete(whereMapKey(where));
      else meta.set(whereMapKey(where), value);
    },
  };
}
