/** The row table held in JS `Map`s, which a store runs on on web and in every test. */

import { cacheKeyOf } from '../args_key';
import { createPresence, whereMapKey } from './presence';
import { noteTableRead } from './read_coverage';
import { FindOpts, memoryColumns, RowShape, RowTable, RowTableSchema } from './types';
import { assertRowsMatchWhere, assertUnitColumn, comparator, matchesWhere } from './query';
import { NO_CHANGES, WriteResult } from './change_set';
import { changedUnits, rowSignature } from './unit_diff';

type Entries<Row> = Iterable<[string, Row]>;

/** One index over a column prefix: the rows under each combination of its columns' values, by their storage key. */
interface MemoryIndex<Row extends RowShape> {
  columns: ReadonlyArray<keyof Row & string>;
  buckets: Map<string, Map<string, Row>>;
}

const NO_ENTRIES: Entries<never> = [];

/** A value's spelling in an index key. Values `matchesWhere` calls equal always share one, so a bucket never misses a row. */
function indexPart(value: unknown): string {
  if (value == null) return '\u0000';
  return typeof value === 'number' ? `n${value}` : `s${String(value)}`;
}

function indexKey<Row extends RowShape>(row: Partial<Row>, columns: ReadonlyArray<keyof Row & string>): string {
  let key = '';
  for (const column of columns) key += `${indexPart(row[column])}\u0001`;
  return key;
}

/**
 * Every leading run of every declared index, and of the primary key short of its last column (the whole key is the
 * row map itself), each once: a read binding `partition_key` alone is served by the same declaration that serves one
 * binding `partition_key` and `player_id`.
 */
function indexPrefixes<Row extends RowShape>(schema: RowTableSchema<Row>): Array<ReadonlyArray<keyof Row & string>> {
  const declared = [...(schema.indexes ?? []).map((index) => index.columns), schema.primaryKey.slice(0, -1)];
  const seen = new Map<string, ReadonlyArray<keyof Row & string>>();
  for (const columns of declared) {
    for (let length = 1; length <= columns.length; length += 1) {
      const prefix = columns.slice(0, length);
      seen.set(prefix.join('\u0001'), prefix);
    }
  }
  return [...seen.values()];
}

/**
 * The {@link RowTable} a store gets where the platform has no SQLite: the web build, every test, a store whose SQLite
 * never bound, and one that lost it mid-session. It answers a read exactly as SQLite would, and like SQLite it finds
 * rows through the schema's primary key and indexes rather than by scanning, so a read of one player costs the same
 * whether the table holds one partition or fifty. It holds the rows on the JS heap, so it saves none of the memory the
 * off-heap design is for, and it neither stores nor compares a `sqliteOnly` column.
 */
export function createMemoryRowTable<Row extends RowShape>(schema: RowTableSchema<Row>): RowTable<Row> {
  if (__DEV__) assertUnitColumn(schema);
  const hasPk = schema.primaryKey.length > 0;
  const { unit } = schema;
  const cols = memoryColumns(schema);
  const rows = new Map<string, Row>();
  const indexes: Array<MemoryIndex<Row>> = indexPrefixes(schema).map((columns) => ({ columns, buckets: new Map() }));
  const presence = createPresence();
  const meta = new Map<string, string>();

  const pkOf = (row: Partial<Row>): string => cacheKeyOf(schema.primaryKey.map((column) => String(row[column])));
  // A table without a primary key can hold equal rows, so each row it stores gets a key of its own.
  let stored = 0;
  const keyOf = hasPk ? pkOf : (): string => `#${(stored += 1)}`;
  const inUnits = (changed: ReadonlySet<string>) => (row: Row) => changed.has(String(row[unit]));

  function dropFromIndex(index: MemoryIndex<Row>, bucketKey: string, key: string): void {
    const bucket = index.buckets.get(bucketKey);
    if (!bucket) return;
    bucket.delete(key);
    if (!bucket.size) index.buckets.delete(bucketKey);
  }

  function put(key: string, row: Row): void {
    const held = rows.get(key);
    rows.set(key, row);
    for (const index of indexes) {
      const bucketKey = indexKey(row, index.columns);
      if (held) {
        const heldKey = indexKey(held, index.columns);
        if (heldKey !== bucketKey) dropFromIndex(index, heldKey, key);
      }
      let bucket = index.buckets.get(bucketKey);
      if (!bucket) index.buckets.set(bucketKey, (bucket = new Map()));
      bucket.set(key, row);
    }
  }

  function remove(key: string, row: Row): void {
    rows.delete(key);
    for (const index of indexes) dropFromIndex(index, indexKey(row, index.columns), key);
  }

  // Which index serves a filter depends only on the columns it binds, and a store asks with a handful of shapes.
  const indexForShape = new Map<string, MemoryIndex<Row> | null>();
  function widestIndex(where: Partial<Row>): MemoryIndex<Row> | undefined {
    const shape = Object.keys(where).sort().join('\u0001');
    let found = indexForShape.get(shape);
    if (found === undefined) {
      found = null;
      for (const index of indexes) {
        if (index.columns.every((column) => column in where) && (!found || index.columns.length > found.columns.length)) found = index;
      }
      indexForShape.set(shape, found);
    }
    return found ?? undefined;
  }

  /** The rows `where` could match: the one its primary key names, the bucket of the widest index it binds, or every row. */
  function candidates(where: Partial<Row>): Entries<Row> {
    if (hasPk && schema.primaryKey.every((column) => column in where)) {
      const key = pkOf(where);
      const row = rows.get(key);
      return row ? [[key, row]] : NO_ENTRIES;
    }
    const index = widestIndex(where);
    if (!index) return rows.entries();
    return index.buckets.get(indexKey(where, index.columns))?.entries() ?? NO_ENTRIES;
  }

  function matching(where: Partial<Row>): Array<[string, Row]> {
    const out: Array<[string, Row]> = [];
    for (const entry of candidates(where)) if (matchesWhere(entry[1], where)) out.push(entry);
    return out;
  }

  function removeWhere(where: Partial<Row>, also: (row: Row) => boolean): void {
    for (const [key, row] of matching(where)) if (also(row)) remove(key, row);
  }

  function insertRows(incoming: Iterable<Row>): void {
    for (const row of incoming) put(keyOf(row), row);
  }

  /** Rewrites only the units whose rows differ, so an unchanged unit keeps the very row objects it held. */
  function overwriteWith(where: Partial<Row>, incoming: readonly Row[]): WriteResult {
    if (__DEV__) assertRowsMatchWhere(schema.table, where, incoming);
    const before = matching(where).map((entry) => entry[1]);
    const changed = changedUnits(before, incoming, unit, cols);
    if (changed.size) {
      const changedRow = inUnits(changed);
      removeWhere(where, changedRow);
      insertRows(incoming.filter(changedRow));
    }
    presence.afterDelete(where);
    return { changes: changed.size ? changed : NO_CHANGES, rows: incoming.length };
  }

  /** A `findIn` value compares against a row's column as a string, so the value `'5'` also names a numeric `5`. */
  function spellingsOf(value: string): Array<string | number> {
    const numeric = Number(value);
    return value.trim() !== '' && String(numeric) === value ? [value, numeric] : [value];
  }

  // As in SQL, where `IN` never matches NULL.
  const inValues = (wanted: ReadonlySet<string>, value: unknown): boolean => value != null && wanted.has(String(value));

  return {
    engine: 'memory',
    primaryKey: schema.primaryKey,
    unit,

    init(): void {},

    async upsert(incoming: readonly Row[]): Promise<WriteResult> {
      const changed = new Set<string>();
      const moved: Row[] = [];
      for (const row of incoming) {
        const held = hasPk ? rows.get(pkOf(row)) : undefined;
        if (held && rowSignature(held, cols) === rowSignature(row, cols)) continue;
        changed.add(String(row[unit]));
        moved.push(row);
      }
      insertRows(moved);
      if (moved.length) presence.afterInsert();
      return { changes: changed.size ? changed : NO_CHANGES, rows: incoming.length };
    },

    overwrite(where: Partial<Row>, incoming: readonly Row[]): WriteResult {
      return overwriteWith(where, incoming);
    },

    async shred(where: Partial<Row>, rawJson: string, parseRows: (rawJson: string) => Row[]): Promise<WriteResult> {
      return overwriteWith(where, parseRows(rawJson));
    },

    getOne(where: Partial<Row>): Row | undefined {
      noteTableRead();
      for (const [, row] of candidates(where)) if (matchesWhere(row, where)) return row;
      return undefined;
    },

    find(where: Partial<Row>, opts?: FindOpts<Row>): Row[] {
      noteTableRead();
      const out = matching(where).map((entry) => entry[1]);
      if (opts?.orderBy) out.sort(comparator<Row>(opts.orderBy));
      return out;
    },

    findIn(where: Partial<Row>, column: keyof Row & string, values: readonly string[], _opts?: { chunk?: number }): Row[] {
      noteTableRead();
      if (!values.length) return [];
      const wanted = new Set(values);
      const out: Row[] = [];
      const narrowed = widestIndex({ ...where, [column]: null });
      if (narrowed && narrowed.columns.includes(column)) {
        // One bucket per value, in the order the values were asked for; a key reached twice is emitted once.
        const emitted = new Set<string>();
        for (const value of wanted) {
          for (const spelling of spellingsOf(value)) {
            for (const [key, row] of candidates({ ...where, [column]: spelling } as Partial<Row>)) {
              if (emitted.has(key) || !matchesWhere(row, where) || !inValues(wanted, row[column])) continue;
              emitted.add(key);
              out.push(row);
            }
          }
        }
        return out;
      }
      for (const [, row] of candidates(where)) {
        if (matchesWhere(row, where) && inValues(wanted, row[column])) out.push(row);
      }
      return out;
    },

    has(where: Partial<Row>): boolean {
      noteTableRead();
      const cached = presence.get(where);
      if (cached !== undefined) return cached;
      let found = false;
      for (const [, row] of candidates(where)) {
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
      for (const [, row] of candidates(where)) if (matchesWhere(row, where)) seen.add(String(row[unit]));
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
