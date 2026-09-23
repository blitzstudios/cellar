import { definePartitions } from '../../define_partitions';
import { createMemoryRowTable } from '../../table/memory';
import { createSqliteRowTable } from '../../table/sqlite';
import { createVersionAtom } from '../../reactivity/version_atom';
import { runTracked } from '../../reactivity/tracking';
import { RowTable, RowTableSchema } from '../../table/types';
import { createSqlJsConnection, initSqlJs } from '../../testing/sqljs_connection';
import { installTestRuntime } from '../../testing/runtime';
import { itDev } from '../../testing/dev_mode';
import { resetOnceGuards } from '../../diagnostics/once_guard';

installTestRuntime();

type PlayerRow = { sport: string; player_id: string; name: string; team: string | null; rank: number | null };
type PlayerKey = { sport: string };

/** One row per player: the primary key less the partition is exactly the unit. */
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
  unit: 'player_id',
};

const NFL: PlayerKey = { sport: 'nfl' };

function player(id: string, name: string, team: string | null = 'NE', rank: number | null = 1): PlayerRow {
  return { sport: 'nfl', player_id: id, name, team, rank };
}

/** The view model a projection builds, deliberately carrying only part of the row so a change outside it still counts. */
type NameVm = { id: string; label: string };

function harness(over: { table?: RowTable<PlayerRow>; max?: number; of?: (rows: readonly PlayerRow[]) => NameVm | undefined } = {}) {
  const table = over.table ?? createMemoryRowTable(SCHEMA);
  table.init();
  const version = createVersionAtom('projection_test');

  const players = definePartitions<PlayerRow, PlayerKey>({
    name: 'player',
    table,
    version,
    key: { fields: ['sport'], where: ({ sport }) => ({ sport }) },
    fetch: { query: () => ({ queryFn: async () => ({ data: '[]' }) }), parse: () => [] },
  });

  const of = jest.fn(over.of ?? (([row]: readonly PlayerRow[]): NameVm | undefined => ({ id: row.player_id, label: row.name })));
  const projection = players.project<NameVm>()({ name: 'name', max: over.max ?? 64, of });

  /** Writes the partition the way an ingest does: the table says what changed, and the bump carries it. */
  const seed = (rows: readonly PlayerRow[]): void => {
    const { changes } = table.overwrite({ sport: 'nfl' }, rows as PlayerRow[]);
    players.bump(NFL, changes);
  };

  return { players, table, projection, of, seed };
}

const idsOf = (deps: readonly { id: string }[]): string[] => deps.map((dep) => dep.id);

describe('row projection — a write rebuilds only the units it changed', () => {
  it('builds one view model per unit, and answers a repeat without rebuilding', () => {
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

  it('rebuilds nothing for a write that changed nothing, which bumps nothing at all', () => {
    const { projection, of, players, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    const before = projection.byIds(NFL, ['p1', 'p2']);
    const version = players.versionOf(NFL);
    of.mockClear();

    seed([player('p1', 'Alice'), player('p2', 'Bob')]);

    expect(players.versionOf(NFL)).toBe(version);
    expect(projection.byIds(NFL, ['p1', 'p2'])).toEqual(before);
    expect(of).not.toHaveBeenCalled();
  });

  it('rebuilds the one unit that moved and holds the reference of every unit that did not', () => {
    const { projection, of, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob'), player('p3', 'Cara')]);
    const before = projection.byIds(NFL, ['p1', 'p2', 'p3']);
    of.mockClear();

    seed([player('p1', 'Alice'), player('p2', 'Robert'), player('p3', 'Cara')]);
    const after = projection.byIds(NFL, ['p1', 'p2', 'p3']);

    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1].label).toBe('Robert');
    expect(of).toHaveBeenCalledTimes(1);
  });

  it('counts a change the view model does not show, since the write, not the view model, decides what changed', () => {
    const { projection, of, seed } = harness();
    seed([player('p1', 'Alice', 'NE', 1)]);
    projection.one(NFL, 'p1');
    of.mockClear();

    seed([player('p1', 'Alice', 'NE', 2)]);
    projection.one(NFL, 'p1');

    expect(of).toHaveBeenCalledTimes(1);
  });

  it('shares one memo across every read of the shape, so a unit asked for three ways is built once', () => {
    const { projection, of, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);

    const viaOne = projection.one(NFL, 'p1');
    const viaIds = projection.byIds(NFL, ['p1'])[0];
    const viaTeam = projection.where(NFL, { team: 'NE' }).find((vm) => vm.id === 'p1');

    expect(viaIds).toBe(viaOne);
    expect(viaTeam).toBe(viaOne);
    expect(of).toHaveBeenCalledTimes(2);
  });
});

describe('row projection — what a read depends on', () => {
  it('a read of named units depends on those units and not the partition, so a write to another leaves it asleep', () => {
    const { projection, players, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);

    const { deps } = runTracked(() => projection.byIds(NFL, ['p1']));
    expect(idsOf(deps)).toEqual([expect.stringMatching(/\u0001p1$/)]);

    const [dep] = deps;
    const listener = jest.fn();
    dep.subscribe(listener);
    seed([player('p1', 'Alice'), player('p2', 'Robert')]);
    expect(listener).not.toHaveBeenCalled();
    seed([player('p1', 'Alicia'), player('p2', 'Robert')]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(players.versionOf(NFL)).toBeGreaterThan(0);
  });

  it('a read over a filter depends on the partition, since which units match can move with any write', () => {
    const { projection, seed } = harness();
    seed([player('p1', 'Alice')]);

    const { deps } = runTracked(() => projection.where(NFL, { team: 'NE' }));

    expect(idsOf(deps)).toContainEqual('projection_test\u0000nfl');
  });
});

describe('row projection — what it hands back', () => {
  it('orders by the ids asked for, not by storage order, and drops an id with no rows', () => {
    const { projection, seed } = harness();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    expect(projection.byIds(NFL, ['p2', 'missing', 'p1']).map((vm) => vm.id)).toEqual(['p2', 'p1']);
  });

  it('remembers that a unit is absent, so a write to another unit does not send it asking again', () => {
    const { projection, table, seed } = harness();
    seed([player('p1', 'Alice')]);
    projection.byIds(NFL, ['missing']);
    const findIn = jest.spyOn(table, 'findIn');

    seed([player('p1', 'Alicia')]);
    projection.byIds(NFL, ['missing']);

    expect(findIn).not.toHaveBeenCalled();
  });

  it('notices a unit that arrives where there was none', () => {
    const { projection, seed } = harness();
    seed([player('p1', 'Alice')]);
    expect(projection.one(NFL, 'p2')).toBeUndefined();

    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    expect(projection.one(NFL, 'p2')?.label).toBe('Bob');
  });

  it('keys by id when asked for a map, and leaves out what it has no rows for', () => {
    const { projection, seed } = harness();
    seed([player('p1', 'Alice')]);
    expect(Object.keys(projection.mapByIds(NFL, ['p1', 'missing']))).toEqual(['p1']);
  });

  it('narrows to a filter within the partition, and reflects a unit leaving that filter', () => {
    const { projection, seed } = harness();
    seed([player('p1', 'Alice', 'NE'), player('p2', 'Bob', 'KC')]);
    expect(projection.where(NFL, { team: 'NE' }).map((vm) => vm.id)).toEqual(['p1']);

    seed([player('p1', 'Alice', 'KC'), player('p2', 'Bob', 'KC')]);
    expect(projection.where(NFL, { team: 'NE' })).toEqual([]);
    expect(projection.all(NFL).map((vm) => vm.id).sort()).toEqual(['p1', 'p2']);
  });

  it('answers an empty ask without touching the rows', () => {
    const { projection, table, seed } = harness();
    seed([player('p1', 'Alice')]);
    const findIn = jest.spyOn(table, 'findIn');

    expect(projection.byIds(NFL, [])).toEqual([]);
    expect(projection.mapByIds(NFL, [])).toEqual({});
    expect(findIn).not.toHaveBeenCalled();
  });

  it('keeps a unit out of the view models where the store says it makes none', () => {
    const { projection, seed } = harness({ of: ([row]) => (row.team ? { id: row.player_id, label: row.name } : undefined) });
    seed([player('p1', 'Alice', null), player('p2', 'Bob', 'NE')]);

    expect(projection.byIds(NFL, ['p1', 'p2']).map((vm) => vm.id)).toEqual(['p2']);
    expect(projection.all(NFL).map((vm) => vm.id)).toEqual(['p2']);
  });
});

describe('row projection — a unit of several rows', () => {
  type GameRow = { week: string; game_id: string; player_id: string; team: string; pts: number };
  const GAMES: RowTableSchema<GameRow> = {
    table: 'games',
    columns: { week: { type: 'TEXT' }, game_id: { type: 'TEXT' }, player_id: { type: 'TEXT' }, team: { type: 'TEXT' }, pts: { type: 'REAL' } },
    primaryKey: ['week', 'game_id', 'player_id'],
    unit: 'player_id',
  };
  type TotalVm = { id: string; games: number; pts: number };

  function games() {
    const table = createMemoryRowTable(GAMES);
    const version = createVersionAtom('projection_games_test');
    const weeks = definePartitions<GameRow, string>({ name: 'games', table, version, key: { where: (week) => ({ week }) } });
    const of = jest.fn((rows: readonly GameRow[]): TotalVm => ({ id: rows[0].player_id, games: rows.length, pts: rows.reduce((sum, row) => sum + row.pts, 0) }));
    const totals = weeks.project<TotalVm>()({ name: 'totals', max: 64, of });
    const seed = (rows: GameRow[]) => weeks.bump('w1', table.overwrite({ week: 'w1' }, rows).changes);
    return { totals, of, seed };
  }
  const game = (id: string, playerId: string, team: string, pts: number): GameRow => ({ week: 'w1', game_id: id, player_id: playerId, team, pts });

  it('hands a unit every one of its rows', () => {
    const { totals, seed } = games();
    seed([game('g1', 'p1', 'LAL', 10), game('g2', 'p1', 'LAL', 20), game('g1', 'p2', 'BOS', 5)]);

    expect(totals.byIds('w1', ['p1', 'p2'])).toEqual([
      { id: 'p1', games: 2, pts: 30 },
      { id: 'p2', games: 1, pts: 5 },
    ]);
  });

  it('builds a filtered read from the rows the filter holds, apart from the unit whole, since they differ', () => {
    const { totals, seed } = games();
    // Traded mid-week: one game for each team.
    seed([game('g1', 'p1', 'BOS', 10), game('g2', 'p1', 'LAL', 20)]);

    const whole = totals.one('w1', 'p1');
    const forLakers = totals.where('w1', { team: 'LAL' })[0];

    expect(whole).toEqual({ id: 'p1', games: 2, pts: 30 });
    expect(forLakers).toEqual({ id: 'p1', games: 1, pts: 20 });
    expect(totals.one('w1', 'p1')).toBe(whole);
  });
});

describe('row projection — the memo bound is a bound, not a promise', () => {
  it('stays correct when the ask exceeds what it holds, even though the references cannot survive', () => {
    const { projection, seed } = harness({ max: 2 });
    const rows = [player('p1', 'A'), player('p2', 'B'), player('p3', 'C'), player('p4', 'D')];
    seed(rows);
    const ids = rows.map((row) => row.player_id);

    expect(projection.byIds(NFL, ids).map((vm) => vm.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(projection.byIds(NFL, ids).map((vm) => vm.label)).toEqual(['A', 'B', 'C', 'D']);
  });

  itDev('says so in dev, naming the projection and the bound to raise', () => {
    resetOnceGuards();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { projection, seed } = harness({ max: 2 });
    seed([player('p1', 'A'), player('p2', 'B'), player('p3', 'C')]);

    projection.byIds(NFL, ['p1', 'p2', 'p3']);

    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/'name' projection was asked for 3 units but holds 2/);
    warn.mockRestore();
  });
});

describe('row projection — over real SQLite', () => {
  beforeAll(async () => {
    await initSqlJs();
  });

  const onSqlite = () => harness({ table: createSqliteRowTable(SCHEMA, createSqlJsConnection({ capabilities: 'full' })) });

  it('rebuilds exactly as the Map backend does', () => {
    const { projection, seed } = onSqlite();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    const before = projection.byIds(NFL, ['p1', 'p2']);

    seed([player('p1', 'Alice'), player('p2', 'Robert')]);
    const after = projection.byIds(NFL, ['p1', 'p2']);

    expect(after[0]).toBe(before[0]);
    expect(after[1].label).toBe('Robert');
  });

  it('reads no rows at all for a partition whose write changed nothing', () => {
    const { projection, table, seed } = onSqlite();
    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    projection.byIds(NFL, ['p1', 'p2']);
    const findIn = jest.spyOn(table, 'findIn');

    seed([player('p1', 'Alice'), player('p2', 'Bob')]);
    projection.byIds(NFL, ['p1', 'p2']);

    expect(findIn).not.toHaveBeenCalled();
  });
});
