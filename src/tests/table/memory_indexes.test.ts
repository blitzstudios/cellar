/**
 * The in-memory table finds rows through its indexes, and has to find exactly the rows SQLite does. Every read is checked
 * against a SQLite table fed the same writes, over a seeded run of writes that move rows between index buckets.
 */

import { configureDataKernel, INERT_ERRORS } from '../../runtime';
import { createMemoryRowTable } from '../../table/memory';
import { createSqliteRowTable } from '../../table/sqlite';
import { RowShape, RowTable, RowTableSchema } from '../../table/types';
import { createSqlJsConnection, initSqlJs } from '../../testing/sqljs_connection';

type Thing = { id: string; region: string; cohort: string | null; num: number | null; note: string | null };

const keyed: RowTableSchema<Thing> = {
  table: 'things',
  columns: {
    id: { type: 'TEXT', notNull: true },
    region: { type: 'TEXT', notNull: true },
    cohort: { type: 'TEXT' },
    num: { type: 'INTEGER' },
    note: { type: 'TEXT', sqliteOnly: true },
  },
  primaryKey: ['region', 'id'],
  unit: 'id',
  indexes: [{ name: 'idx_things_cohort', columns: ['region', 'cohort', 'num'] }],
};

const unkeyed: RowTableSchema<Thing> = { ...keyed, table: 'snapshots', primaryKey: [], indexes: [{ name: 'idx_snapshots_region', columns: ['region'] }] };

const REGIONS = ['us', 'eu', 'ap'];
const COHORTS = ['NE', 'KC', null];
const NUMS = [0, 1, 2, null];
const IDS = ['a', 'b', 'c', 'd', 'e', 'f'];

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A row's identity for comparing two tables' answers, which come back in their own storage orders. */
const signature = (row: RowShape | undefined): string => (row ? JSON.stringify([row.id, row.region, row.cohort, row.num]) : '-');
const asSet = (rows: readonly RowShape[]): string[] => rows.map(signature).sort();

const WHERES: Array<Partial<Thing>> = [
  {},
  { region: 'us' },
  { region: 'eu', cohort: 'NE' },
  { region: 'us', cohort: null },
  { region: 'ap', cohort: 'KC', num: 1 },
  { region: 'us', cohort: 'NE', num: null },
  { cohort: 'KC' },
  { num: 2 },
  { region: 'eu', num: 0 },
  { region: 'us', id: 'c' },
];

beforeAll(async () => {
  await initSqlJs();
});

beforeEach(() => {
  configureDataKernel({ errors: INERT_ERRORS });
});

describe.each([
  { name: 'with a primary key', schema: keyed },
  { name: 'without one', schema: unkeyed },
])('memory table indexes agree with SQLite — $name', ({ schema }) => {
  it('over a seeded run of overwrites and upserts', async () => {
    const random = mulberry32(schema === keyed ? 7 : 11);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
    const memory = createMemoryRowTable(schema);
    const sqlite = createSqliteRowTable(schema, createSqlJsConnection({ capabilities: 'full' }));
    memory.init();
    sqlite.init();
    const tables: Array<RowTable<Thing>> = [memory, sqlite];

    const makeRows = (where: Partial<Thing>, count: number): Thing[] => {
      const ids = schema.primaryKey.length ? [...IDS].sort(() => random() - 0.5).slice(0, count) : Array.from({ length: count }, () => pick(IDS));
      return ids.map((id) => ({ id, region: pick(REGIONS), cohort: pick(COHORTS), num: pick(NUMS), note: 'x', ...where }));
    };

    for (let step = 0; step < 250; step += 1) {
      if (schema.primaryKey.length && random() < 0.35) {
        const rows = makeRows({}, 1 + Math.floor(random() * 3));
        // eslint-disable-next-line no-await-in-loop
        for (const table of tables) await table.upsert(rows);
      } else {
        const where: Partial<Thing> = random() < 0.5 ? { region: pick(REGIONS) } : { region: pick(REGIONS), cohort: pick(COHORTS) };
        const rows = makeRows(where, Math.floor(random() * 5));
        for (const table of tables) table.overwrite(where, rows);
      }

      for (const where of WHERES) {
        const [fromMemory, fromSqlite] = tables.map((table) => asSet(table.find(where)));
        expect({ step, where, rows: fromMemory }).toEqual({ step, where, rows: fromSqlite });
        expect({ step, where, units: [...memory.unitsWhere(where)].sort() }).toEqual({ step, where, units: [...sqlite.unitsWhere(where)].sort() });
        expect({ step, where, has: memory.has(where) }).toEqual({ step, where, has: sqlite.has(where) });
        const one = memory.getOne(where);
        expect({ step, where, one: one ? fromSqlite.includes(signature(one)) : fromSqlite.length === 0 }).toEqual({ step, where, one: true });
      }
      const ids = [pick(IDS), pick(IDS), 'zz'];
      for (const where of [{ region: pick(REGIONS) }, {}]) {
        const [fromMemory, fromSqlite] = tables.map((table) => asSet(table.findIn(where, 'id', ids)));
        expect({ step, where, ids, rows: fromMemory }).toEqual({ step, where, ids, rows: fromSqlite });
      }
      const [numsFromMemory, numsFromSqlite] = tables.map((table) => asSet(table.findIn({ region: 'us' }, 'num', ['1', '2'])));
      expect({ step, nums: numsFromMemory }).toEqual({ step, nums: numsFromSqlite });
    }
  });
});

describe('memory table — sqliteOnly columns', () => {
  it('reports no change for a write that differs only in a sqliteOnly column', () => {
    const memory = createMemoryRowTable(keyed);
    memory.overwrite({ region: 'us' }, [{ id: 'a', region: 'us', cohort: 'NE', num: 1, note: 'first' }]);
    const { changes } = memory.overwrite({ region: 'us' }, [{ id: 'a', region: 'us', cohort: 'NE', num: 1, note: 'second' }]);
    expect([...(changes as Set<string>)]).toEqual([]);
  });

  it('says which engine it is, so a store can skip building those columns', () => {
    expect(createMemoryRowTable(keyed).engine).toBe('memory');
    expect(createSqliteRowTable(keyed, createSqlJsConnection()).engine).toBe('sqlite');
  });
});

describe('memory table — reads cost what their index says, not what the table holds', () => {
  it('reads one row without visiting the others', () => {
    const memory = createMemoryRowTable(keyed);
    for (const region of REGIONS) {
      memory.overwrite({ region }, Array.from({ length: 2000 }, (_value, index) => ({ id: `p${index}`, region, cohort: 'NE', num: index % 3, note: null })));
    }
    const visited = jest.fn();
    const probe = new Proxy({ region: 'eu', id: 'p7' }, { ownKeys: (target) => (visited(), Reflect.ownKeys(target)) });
    expect(memory.getOne(probe)?.id).toBe('p7');
    // `matchesWhere` walks the filter's keys once per row it tests, so one visit means one candidate row.
    expect(visited.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
