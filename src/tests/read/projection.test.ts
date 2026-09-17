import { definePartitions } from '../../define_partitions';
import { createMemoryRowTable } from '../../table/memory';
import { createSqliteRowTable } from '../../table/sqlite';
import { createVersionAtom } from '../../reactivity/version_atom';
import { RowTable, RowTableSchema } from '../../table/types';
import { createSqlJsConnection, initSqlJs } from '../../testing/sqljs_connection';
import { installTestRuntime } from '../../testing/runtime';
import { itDev } from '../../testing/dev_mode';
import { resetOnceGuards } from '../../diagnostics/once_guard';

installTestRuntime();

type PlayerRow = { sport: string; player_id: string; name: string; team: string | null; rank: number | null };
type PlayerKey = { sport: string };

const SCHEMA: RowTableSchema<PlayerRow> = {
  table: 'players',
  columns: {
    sport: { type: 'TEXT', notNull: true },
    player_id: { type: 'TEXT', notNull: true },
    name: { type: 'TEXT', notNull: true },
    team: { type: 'TEXT' },
    rank: { type: 'INTEGER' },
  },
  primaryKey: ['sport', 'player_id'],
};

const NFL: PlayerKey = { sport: 'nfl' };

function player(id: string, name: string, team: string | null = 'NE', rank: number | null = 1): PlayerRow {
  return { sport: 'nfl', player_id: id, name, team, rank };
}

/** The view model a projection builds, deliberately carrying only part of the row so a change outside it still counts. */
type NameVm = { id: string; label: string };

function harness(
  over: {
    table?: RowTable<PlayerRow>;
    max?: number;
    by?: keyof PlayerRow & string;
    where?: () => Partial<PlayerRow>;
    of?: (row: PlayerRow) => NameVm | undefined;
  } = {},
) {
  const table = over.table ?? createMemoryRowTable(SCHEMA);
  table.init();
  const version = createVersionAtom('projection_test');

  const players = definePartitions<PlayerRow, PlayerKey>({
    name: 'player',
    table,
    version,
    key: { fields: ['sport'], where: over.where ?? (({ sport }) => ({ sport })) },
    fetch: { query: () => ({ queryFn: async () => ({ data: '[]' }) }), parse: () => [] },
  });

  const of = jest.fn(over.of ?? ((row: PlayerRow): NameVm | undefined => ({ id: row.player_id, label: row.name })));
  const projection = players.project<NameVm>()({ name: 'name', max: over.max ?? 64, by: over.by, of });

  const seed = (rows: readonly PlayerRow[]): void => {
    table.overwrite({ sport: 'nfl' }, rows as PlayerRow[]);
    players.bump(NFL);
  };

  return { players, table, projection, of, seed };
}

describe('row projection — a bump rebuilds only the rows that moved', () => {
  it('builds one view model per row, and answers a repeat at the same version without rebuilding', () => {
    const { projection, of, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);

    const first = projection.byIds(NFL, ['p1', 'p2']);
    expect(first.map((vm) => vm.label)).toEqual(['Alice', 'Bob']);
    expect(of).toHaveBeenCalledTimes(2);

    const second = projection.byIds(NFL, ['p1', 'p2']);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(of).toHaveBeenCalledTimes(2);
  });

  it('rebuilds nothing across a bump that changed no row, which is the case a version alone cannot tell apart', () => {
    const { projection, of, players, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    const before = projection.byIds(NFL, ['p1', 'p2']);
    of.mockClear();

    players.bump(NFL);

    const after = projection.byIds(NFL, ['p1', 'p2']);
    expect(of).not.toHaveBeenCalled();
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it('rebuilds the one row that moved and holds the reference of every row that did not', () => {
    const { projection, of, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob'), player('p3', 'Cara')]);
    const before = projection.byIds(NFL, ['p1', 'p2', 'p3']);
    of.mockClear();

    seed([player('p1', 'Alice'), player('p2', 'Bobby'), player('p3', 'Cara')]);

    const after = projection.byIds(NFL, ['p1', 'p2', 'p3']);
    expect(of).toHaveBeenCalledTimes(1);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1].label).toBe('Bobby');
  });

  it('counts a change the view model does not even show, since a stale digest is the worse failure', () => {
    const { projection, of, seed } = harness();
    seed([player('p1', 'Alice', 'NE', 1)]);
    projection.byIds(NFL, ['p1']);
    of.mockClear();

    seed([player('p1', 'Alice', 'KC', 1)]);

    projection.byIds(NFL, ['p1']);
    expect(of).toHaveBeenCalledTimes(1);
  });

  it('shares one memo across every read of the shape, so a row asked for two ways is built once', () => {
    const { projection, of, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);

    projection.one(NFL, 'p1');
    expect(of).toHaveBeenCalledTimes(1);

    const all = projection.all(NFL);
    expect(of).toHaveBeenCalledTimes(2);
    expect(all.find((vm) => vm.id === 'p1')).toBe(projection.one(NFL, 'p1'));
    expect(of).toHaveBeenCalledTimes(2);
  });
});

describe('row projection — what it hands back', () => {
  it('orders by the ids asked for, not by storage order, and drops an id with no row', () => {
    const { projection, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    expect(projection.byIds(NFL, ['p2', 'missing', 'p1']).map((vm) => vm.id)).toEqual(['p2', 'p1']);
  });

  it('remembers that a row is absent, so a bump does not send it asking again', () => {
    const { projection, of, players, seed } = harness();
    seed([player('p1', 'Alice')]);

    expect(projection.one(NFL, 'missing')).toBeUndefined();
    of.mockClear();
    players.bump(NFL);
    expect(projection.one(NFL, 'missing')).toBeUndefined();
    expect(of).not.toHaveBeenCalled();
  });

  it('notices a row that arrives where there was none', () => {
    const { projection, seed } = harness();
    seed([player('p1', 'Alice')]);
    expect(projection.one(NFL, 'p2')).toBeUndefined();

    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    expect(projection.one(NFL, 'p2')?.label).toBe('Bob');
  });

  it('keys by id when asked for a map, and leaves out what it has no row for', () => {
    const { projection, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    expect(projection.mapByIds(NFL, ['p1', 'missing'])).toEqual({ p1: { id: 'p1', label: 'Alice' } });
  });

  it('narrows to a filter within the partition, and reflects a row leaving that filter', () => {
    const { projection, seed } = harness();
    seed([player('p1', 'Alice', 'NE'), player('p2', 'Bob', 'KC')]);
    expect(projection.where(NFL, { team: 'NE' }).map((vm) => vm.id)).toEqual(['p1']);

    seed([player('p1', 'Alice', 'KC'), player('p2', 'Bob', 'KC')]);
    expect(projection.where(NFL, { team: 'NE' })).toEqual([]);
    expect(projection.where(NFL, { team: 'KC' }).map((vm) => vm.id).sort()).toEqual(['p1', 'p2']);
  });

  it('answers an empty ask without touching the rows', () => {
    const { projection, of, seed } = harness();
    seed([player('p1', 'Alice')]);
    expect(projection.byIds(NFL, [])).toEqual([]);
    expect(projection.mapByIds(NFL, [])).toEqual({});
    expect(of).not.toHaveBeenCalled();
  });

  it('keeps a row out of the view models where the store says it makes none', () => {
    const { projection, of, players, seed } = harness({
      of: (row) => (row.name === 'skip' ? undefined : { id: row.player_id, label: row.name }),
    });
    seed([player('p1', 'Alice'), player('p2', 'skip')]);

    expect(projection.all(NFL).map((vm) => vm.id)).toEqual(['p1']);
    expect(projection.byIds(NFL, ['p1', 'p2']).map((vm) => vm.id)).toEqual(['p1']);
    expect(projection.one(NFL, 'p2')).toBeUndefined();

    // Held like any other answer, so the row it declined is not rebuilt on the next bump either.
    of.mockClear();
    players.bump(NFL);
    expect(projection.one(NFL, 'p2')).toBeUndefined();
    expect(of).not.toHaveBeenCalled();
  });
});

describe('row projection — the memo bound is a bound, not a promise', () => {
  it('stays correct when the ask exceeds what it holds, even though the references cannot survive', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { projection, seed } = harness({ max: 2 });
    seed([player('p1', 'Alice'), player('p2', 'Bob'), player('p3', 'Cara'), player('p4', 'Dee')]);

    const labels = projection.byIds(NFL, ['p1', 'p2', 'p3', 'p4']).map((vm) => vm.label);
    expect(labels).toEqual(['Alice', 'Bob', 'Cara', 'Dee']);
    expect(projection.byIds(NFL, ['p1', 'p2', 'p3', 'p4']).map((vm) => vm.label)).toEqual(labels);
    warn.mockRestore();
  });

  itDev('warns once when a read cannot possibly fit, since that rebuilds everything on every bump', () => {
    resetOnceGuards();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { projection, seed } = harness({ max: 2 });
    seed([player('p1', 'Alice'), player('p2', 'Bob'), player('p3', 'Cara')]);

    projection.all(NFL);
    projection.all(NFL);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("the 'name' projection was asked for 3 rows but holds 2");
    warn.mockRestore();
  });
});

describe('row projection — what identifies a row', () => {
  it('derives it from the primary key, less what the partition already fixes', () => {
    const { projection, seed } = harness();
    seed([player('p1', 'Alice')]);
    expect(projection.one(NFL, 'p1')?.label).toBe('Alice');
  });

  it('says what to do when the primary key does not narrow to one column', () => {
    const { projection, seed } = harness({ where: () => ({}) });
    seed([player('p1', 'Alice')]);
    expect(() => projection.one(NFL, 'p1')).toThrow(/cannot tell what identifies a row.*sport, player_id.*Name it with `by`/s);
  });

  it('takes the column named instead, which is the way out of that', () => {
    const { projection, seed } = harness({ where: () => ({}), by: 'player_id' });
    seed([player('p1', 'Alice')]);
    expect(projection.one(NFL, 'p1')?.label).toBe('Alice');
  });
});

describe('row projection — over real SQLite', () => {
  beforeAll(async () => {
    await initSqlJs();
  });

  it('revalidates the same way the Map backend does, which is what the digests are for', () => {
    const conn = createSqlJsConnection({ capabilities: 'full' });
    const { projection, of, seed } = harness({ table: createSqliteRowTable(SCHEMA, conn) });
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    const before = projection.byIds(NFL, ['p1', 'p2']);
    of.mockClear();

    seed([player('p1', 'Alice'), player('p2', 'Bobby')]);

    const after = projection.byIds(NFL, ['p1', 'p2']);
    expect(of).toHaveBeenCalledTimes(1);
    expect(after[0]).toBe(before[0]);
    expect(after[1].label).toBe('Bobby');
  });

  it('reads only the rows that moved, so an unchanged partition costs one digest query', () => {
    const conn = createSqlJsConnection({ capabilities: 'full' });
    const { projection, players, seed } = harness({ table: createSqliteRowTable(SCHEMA, conn) });
    seed([player('p1', 'Alice'), player('p2', 'Bob'), player('p3', 'Cara')]);
    projection.byIds(NFL, ['p1', 'p2', 'p3']);

    players.bump(NFL);
    conn.executed.length = 0;
    projection.byIds(NFL, ['p1', 'p2', 'p3']);

    expect(conn.executed.filter((sql) => sql.includes('SELECT *'))).toEqual([]);
    expect(conn.executed).toHaveLength(1);
  });
});
