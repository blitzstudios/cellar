/**
 * A store's cache block: `byUnit` and `byVersion` caches declared together, each named by its key, each discarded by
 * the writes its kind says it is.
 */

import { byVersion } from '../caches';
import { definePartitions } from '../define_partitions';
import { byUnit } from '../read/derived_values';
import { createTestRowTable } from '../testing/row_table';
import { createVersionAtom } from '../reactivity/version_atom';
import { RowTableSchema } from '../table/types';
import { installTestRuntime } from '../testing/runtime';
import { testCache } from '../testing/caches';

installTestRuntime();

type GameRow = { season: string; team: string; week: number };
type SeasonKey = { season: string };

const SCHEMA: RowTableSchema<GameRow> = {
  table: 'games',
  columns: { season: { type: 'TEXT', notNull: true }, team: { type: 'TEXT', notNull: true }, week: { type: 'INTEGER', notNull: true } },
  primaryKey: ['season', 'team', 'week'],
  unit: 'team',
};

const S2026: SeasonKey = { season: '2026' };

function store() {
  const table = createTestRowTable(SCHEMA);
  table.init();
  const partitions = definePartitions<GameRow, SeasonKey>({ name: 'games', table, version: createVersionAtom('cache_block_test'), key: { fields: ['season'], where: ({ season }) => ({ season }) } });
  const weeksBuilt = jest.fn((rows: readonly GameRow[]) => rows.map((row) => row.week));
  const caches = partitions.cache({
    weeksByTeam: byUnit<number[]>()({ max: 64, fromRows: weeksBuilt }),
    lastWeek: byVersion<number>()({ max: 4 }),
  });
  const write = (rows: GameRow[]) => partitions.bump(S2026, table.overwrite(S2026, rows).changes);
  const lastWeek = () => caches.lastWeek.for(S2026).read(() => Math.max(...table.find(S2026).map((row) => row.week)));
  return { ...caches, weeksBuilt, write, lastWeek };
}

describe('a store cache block', () => {
  it('returns one cache per entry, each of its declared kind, under the entry key', () => {
    const { weeksByTeam, write, lastWeek } = store();
    write([
      { season: '2026', team: 'KC', week: 1 },
      { season: '2026', team: 'KC', week: 2 },
      { season: '2026', team: 'BUF', week: 1 },
    ]);

    expect(weeksByTeam.at(S2026, 'KC')).toEqual([1, 2]);
    expect(weeksByTeam.pick(S2026, ['BUF'])).toEqual({ BUF: [1] });
    expect(lastWeek()).toBe(2);
  });

  it('rebuilds a byUnit value only for the units a write changed, and discards a byVersion value on any write', () => {
    const { weeksByTeam, weeksBuilt, write, lastWeek } = store();
    write([
      { season: '2026', team: 'KC', week: 1 },
      { season: '2026', team: 'BUF', week: 1 },
    ]);
    const kc = weeksByTeam.at(S2026, 'KC');
    weeksByTeam.at(S2026, 'BUF');
    expect(lastWeek()).toBe(1);
    weeksBuilt.mockClear();

    write([
      { season: '2026', team: 'KC', week: 1 },
      { season: '2026', team: 'BUF', week: 1 },
      { season: '2026', team: 'BUF', week: 3 },
    ]);

    expect(weeksByTeam.at(S2026, 'KC')).toBe(kc);
    expect(weeksByTeam.at(S2026, 'BUF')).toEqual([1, 3]);
    expect(weeksBuilt).toHaveBeenCalledTimes(1);
    expect(lastWeek()).toBe(3);
  });

  it("takes only byVersion caches in a module's test block, which has no rows to build a byUnit value from", () => {
    const cache = testCache(createVersionAtom('cache_block_module_test'));

    expect(cache({ totals: byVersion<number>()({ max: 4 }) }).totals.for('k').read(() => 7)).toBe(7);
    // @ts-expect-error a byUnit cache needs a store's row type
    expect(() => cache({ names: byUnit<string>()({ max: 4, fromRows: () => 'x' }) })).toThrow(/'names' is a byUnit cache/);
  });
});
