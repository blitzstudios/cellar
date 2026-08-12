/** The shapes a hydration hands a read, and the two guarantees every one of them carries: order, and a stable empty. */

import { createMemoryRowTable } from '../../table/memory';
import { rowsOf } from '../../read/row_shaping';
import { RowTableSchema } from '../../table/types';

type PlayerRow = { sport: string; player_id: string; team: string; num: number | null };

const schema: RowTableSchema<PlayerRow> = {
  table: 'players',
  columns: { sport: { type: 'TEXT' }, player_id: { type: 'TEXT' }, team: { type: 'TEXT' }, num: { type: 'INTEGER' } },
  primaryKey: ['sport', 'player_id'],
};

const row = (sport: string, player_id: string, team: string, num: number | null): PlayerRow => ({ sport, player_id, team, num });

const EMPTY_LIST: string[] = [];
const EMPTY_MAP: Record<string, string> = {};

const name = (player: PlayerRow): string => `${player.player_id}@${player.team}`;

function seeded() {
  const table = createMemoryRowTable(schema);
  table.overwrite({ sport: 'nfl' }, [row('nfl', 'a', 'NE', 3), row('nfl', 'b', 'KC', 1), row('nfl', 'c', 'NE', 2)]);
  table.overwrite({ sport: 'nba' }, [row('nba', 'z', 'BOS', 9)]);
  return rowsOf(table);
}

describe('a row set', () => {
  it('maps every row the mapper keeps, in the order the query asked for', () => {
    expect(seeded().where({ sport: 'nfl' }, { orderBy: 'num' }).map(name, EMPTY_LIST)).toEqual(['b@KC', 'c@NE', 'a@NE']);
  });

  it('drops the rows the mapper turns down', () => {
    const onlyNe = (player: PlayerRow): string | undefined => (player.team === 'NE' ? player.player_id : undefined);

    expect(seeded().where({ sport: 'nfl' }, { orderBy: 'num' }).map(onlyNe, EMPTY_LIST)).toEqual(['c', 'a']);
  });

  it('hands back the caller\u2019s own empty when nothing survives, so a read\u2019s bail-out holds', () => {
    const rows = seeded();

    expect(rows.where({ sport: 'mls' }).map(name, EMPTY_LIST)).toBe(EMPTY_LIST);
    expect(rows.where({ sport: 'nfl' }).map(() => undefined, EMPTY_LIST)).toBe(EMPTY_LIST);
    expect(rows.in({ sport: 'nfl' }, 'player_id', ['nobody']).ordered(name, EMPTY_LIST)).toBe(EMPTY_LIST);
    expect(rows.in({ sport: 'nfl' }, 'player_id', ['nobody']).indexed(name, EMPTY_MAP)).toBe(EMPTY_MAP);
  });

  it('groups by a column, each group in the order its rows arrived', () => {
    const grouped = seeded().where({ sport: 'nfl' }, { orderBy: 'num' }).groupBy('team');

    expect([...grouped.keys()]).toEqual(['KC', 'NE']);
    expect(grouped.get('NE')?.map((player) => player.player_id)).toEqual(['c', 'a']);
  });

  it('shapes rows from somewhere other than a find, which a native filtered read hands over', () => {
    expect(seeded().given([row('nfl', 'q', 'SF', 1)]).map(name, EMPTY_LIST)).toEqual(['q@SF']);
  });
});

describe('the rows an id query matched', () => {
  it('orders them the way the ids were named, not the way storage returned them', () => {
    expect(seeded().in({ sport: 'nfl' }, 'player_id', ['c', 'a', 'b']).ordered(name, EMPTY_LIST)).toEqual(['c@NE', 'a@NE', 'b@KC']);
  });

  it('skips an id the partition does not hold rather than leaving a gap', () => {
    expect(seeded().in({ sport: 'nfl' }, 'player_id', ['c', 'nobody', 'b']).ordered(name, EMPTY_LIST)).toEqual(['c@NE', 'b@KC']);
  });

  it('indexes and groups by the column the query named, so neither has to be told again', () => {
    const matched = seeded().in({ sport: 'nfl' }, 'player_id', ['a', 'b']);

    expect(matched.indexed(name, EMPTY_MAP)).toEqual({ a: 'a@NE', b: 'b@KC' });
    expect([...matched.grouped().keys()].sort()).toEqual(['a', 'b']);
  });

  it('stays inside the filter, so one partition\u2019s ids cannot read another\u2019s rows', () => {
    expect(seeded().in({ sport: 'nfl' }, 'player_id', ['z']).ordered(name, EMPTY_LIST)).toBe(EMPTY_LIST);
  });
});
