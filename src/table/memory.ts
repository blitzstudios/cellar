/** The row table held in JS `Map`s, which is the backend on web and in every test. */

import { cacheKey, cacheKeyOf } from '../args_key';
import { createPresence, whereMapKey } from './presence';
import { FindOpts, RowShape, RowTable, RowTableSchema } from './types';
import { assertRowsMatchWhere, comparator, digestColumns, digestRow, matchesWhere } from './query';

/**
 * The {@link RowTable} a store gets where the platform has no SQLite: the web build, every test, and the stretch before
 * a mobile store's connection is bound. Its rows sit on the JS heap, so it answers a read exactly as SQLite would and
 * saves none of the memory the off-heap design is for.
 */
export function createMemoryRowTable<Row extends RowShape>(schema: RowTableSchema<Row>): RowTable<Row> {
  const hasPk = schema.primaryKey.length > 0;
  const byPk = new Map<string, Row>();
  const rowsList: Row[] = [];
  const presence = createPresence();
  const meta = new Map<string, string>();
  const digestCols = digestColumns(schema);

  const pkOf = (row: Row): string => cacheKeyOf(schema.primaryKey.map((column) => String(row[column])));
  const allRows = (): Iterable<Row> => (hasPk ? byPk.values() : rowsList);

  function removeWhere(where: Partial<Row>): void {
    if (hasPk) {
      for (const [key, row] of byPk) if (matchesWhere(row, where)) byPk.delete(key);
    } else {
      for (let index = rowsList.length - 1; index >= 0; index -= 1) if (matchesWhere(rowsList[index], where)) rowsList.splice(index, 1);
    }
  }

  function insertRows(rows: readonly Row[]): void {
    if (hasPk) {
      for (const row of rows) byPk.set(pkOf(row), row);
    } else {
      for (const row of rows) rowsList.push(row);
    }
  }

  function overwriteWith(where: Partial<Row>, rows: readonly Row[]): number {
    if (__DEV__) assertRowsMatchWhere(schema.table, where, rows);
    removeWhere(where);
    insertRows(rows);
    presence.afterDelete(where);
    return rows.length;
  }

  return {
    primaryKey: schema.primaryKey,

    init(): void {},

    async upsert(rows: readonly Row[]): Promise<number> {
      insertRows(rows);
      presence.afterInsert();
      return rows.length;
    },

    overwrite(where: Partial<Row>, rows: readonly Row[]): number {
      return overwriteWith(where, rows);
    },

    async shred(where: Partial<Row>, rawJson: string, parseRows: (rawJson: string) => Row[]): Promise<number> {
      return overwriteWith(where, parseRows(rawJson));
    },

    getOne(where: Partial<Row>): Row | undefined {
      for (const row of allRows()) if (matchesWhere(row, where)) return row;
      return undefined;
    },

    find(where: Partial<Row>, opts?: FindOpts<Row>): Row[] {
      const out: Row[] = [];
      for (const row of allRows()) if (matchesWhere(row, where)) out.push(row);
      if (opts?.orderBy) out.sort(comparator<Row>(opts.orderBy));
      return out;
    },

    findIn(where: Partial<Row>, column: keyof Row & string, values: readonly string[], _opts?: { chunk?: number }): Row[] {
      if (!values.length) return [];
      const wanted = new Set(values);
      const out: Row[] = [];
      for (const row of allRows()) {
        if (matchesWhere(row, where) && wanted.has(String(row[column]))) out.push(row);
      }
      return out;
    },

    has(where: Partial<Row>): boolean {
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

    digests(where: Partial<Row>, column: keyof Row & string, values?: readonly string[]): Map<string, string> {
      const wanted = values && new Set(values);
      const out = new Map<string, string>();
      if (wanted && !wanted.size) return out;
      for (const row of allRows()) {
        const id = String(row[column]);
        if (matchesWhere(row, where) && (!wanted || wanted.has(id))) out.set(id, digestRow(row, digestCols));
      }
      return out;
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
