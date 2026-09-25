/**
 * What a change-set write costs against the delete-and-reinsert it replaced, on a partition shaped like a live NFL
 * stats week: 2,184 rows, 24 base columns plus 372 generated stat columns of which one sport fills 202, and a stats
 * JSON blob per row. Opt-in, since it is a measurement and not a check: `KERNEL_BENCH=1 yarn jest entity_diff.bench`.
 *
 * sql.js is SQLite compiled to WASM, so the absolute numbers say nothing about a device. The ratios are the point:
 * both strategies run on the same engine, over the same rows, in the same process.
 */

import { createSqliteRowTable } from '../../table/sqlite';
import { RowShape, RowTableSchema } from '../../table/types';
import { runBatch } from '../../table/connection';
import { createSqlJsConnection, initSqlJs } from '../../testing/sqljs_connection';

const bench = process.env.KERNEL_BENCH ? describe : describe.skip;

const ROWS = 2184;
const BASE_TEXT = ['partition_key', 'stat_uid', 'player_id', 'sport', 'category', 'season', 'season_type', 'week', 'game_id', 'date', 'team', 'opponent'];
const BASE_OTHER = ['position', 'first_name', 'last_name', 'status', 'fantasy_positions', 'injury_status', 'player_team', 'stats_json'];
const BASE_NUM = ['updated_at', 'years_exp', 'team_changed_at', 'company_id'];
const STAT_COLUMNS = 372;
const FILLED = 202;

const columns: Record<string, { type: 'TEXT' | 'REAL' | 'INTEGER' }> = {};
for (const name of [...BASE_TEXT, ...BASE_OTHER]) columns[name] = { type: 'TEXT' };
for (const name of BASE_NUM) columns[name] = { type: 'INTEGER' };
for (let index = 0; index < STAT_COLUMNS; index += 1) columns[`s_${index}`] = { type: 'REAL' };

const schema: RowTableSchema<RowShape> = {
  table: 'player_stats',
  columns,
  primaryKey: ['partition_key', 'stat_uid'],
  entityId: 'player_id',
  // The two the real table carries: every row a write lands pays for both.
  indexes: [
    { name: 'idx_player_stats_partition', columns: ['partition_key', 'player_id'] },
    { name: 'idx_player_stats_pos_opp', columns: ['partition_key', 'position', 'opponent'] },
  ],
};
const colList = Object.keys(columns);

function makeRow(index: number, bump = 0): RowShape {
  const row: RowShape = {};
  for (const name of BASE_TEXT) row[name] = `${name}_${name === 'partition_key' ? 'w1' : index}`;
  row.partition_key = 'w1';
  row.stat_uid = `uid_${index}`;
  row.player_id = `p${index}`;
  for (const name of BASE_OTHER) row[name] = `${name}_${index}`;
  row.stats_json = JSON.stringify(Object.fromEntries(Array.from({ length: 60 }, (_, stat) => [`stat_${stat}`, stat * 1.5 + index])));
  for (const name of BASE_NUM) row[name] = index * 7;
  for (let stat = 0; stat < STAT_COLUMNS; stat += 1) row[`s_${stat}`] = stat < FILLED ? stat * 0.5 + index + bump : null;
  return row;
}

const payload = (changed: number): RowShape[] => Array.from({ length: ROWS }, (_, index) => makeRow(index, index < changed ? 1 : 0));

/** The write this replaced: delete the partition, insert every row, one transaction. */
function legacyReplace(conn: ReturnType<typeof createSqlJsConnection>, rows: readonly RowShape[]): void {
  const perInsert = Math.max(1, Math.floor(999 / colList.length));
  const commands: Array<[string, Array<string | number | null>]> = [['DELETE FROM player_stats WHERE partition_key = ?;', ['w1']]];
  for (let start = 0; start < rows.length; start += perInsert) {
    const group = rows.slice(start, start + perInsert);
    const params: Array<string | number | null> = [];
    for (const row of group) for (const column of colList) params.push(row[column] ?? null);
    commands.push([`INSERT OR REPLACE INTO player_stats (${colList.join(', ')}) VALUES ${group.map(() => `(${colList.map(() => '?').join(', ')})`).join(', ')};`, params]);
  }
  runBatch(conn, commands);
}

const median = (values: number[]): number => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];

function time(run: () => void, repeats = 5): number {
  const samples: number[] = [];
  for (let index = 0; index < repeats; index += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

bench('write cost — change-set write vs delete-and-reinsert', () => {
  beforeAll(async () => {
    await initSqlJs();
  });

  it('measures a first load, and rewrites of 0, 4 and every entity', () => {
    const results: Record<string, { legacy: number; changeSet: number }> = {};
    const base = payload(0);

    for (const [label, changed] of [
      ['0 of 2,184 changed', 0],
      ['4 of 2,184 changed', 4],
      ['all changed', ROWS],
    ] as const) {
      const next = payload(changed);

      const legacyConn = createSqlJsConnection({ capabilities: 'full' });
      createSqliteRowTable(schema, legacyConn).init();
      const legacy = time(() => {
        legacyReplace(legacyConn, base);
        legacyReplace(legacyConn, next);
      });

      const conn = createSqlJsConnection({ capabilities: 'full' });
      const table = createSqliteRowTable(schema, conn);
      table.init();
      const changeSet = time(() => {
        table.overwrite({ partition_key: 'w1' }, base);
        table.overwrite({ partition_key: 'w1' }, next);
      });
      // Each sample is the reset to `base` plus the write under test; subtract the reset, measured on its own.
      const legacyReset = time(() => legacyReplace(legacyConn, base));
      const changeSetReset = time(() => table.overwrite({ partition_key: 'w1' }, base));
      results[label] = { legacy: legacy - legacyReset, changeSet: changeSet - changeSetReset };
      legacyConn.close();
      conn.close();
    }

    const firstLegacy = createSqlJsConnection({ capabilities: 'full' });
    createSqliteRowTable(schema, firstLegacy).init();
    const firstConn = createSqlJsConnection({ capabilities: 'full' });
    const firstTable = createSqliteRowTable(schema, firstConn);
    firstTable.init();
    const legacyFirst = time(() => {
      firstLegacy.execute('DELETE FROM player_stats;');
      legacyReplace(firstLegacy, base);
    });
    const changeSetFirst = time(() => {
      firstConn.execute('DELETE FROM player_stats;');
      firstTable.overwrite({ partition_key: 'w1' }, base);
    });
    results['first load'] = { legacy: legacyFirst, changeSet: changeSetFirst };

    // Where a change-set write's time goes when nothing changed: staging alone, then the diff over the staged rows.
    const breakdownConn = createSqlJsConnection({ capabilities: 'full' });
    const breakdownTable = createSqliteRowTable(schema, breakdownConn);
    breakdownTable.init();
    breakdownTable.overwrite({ partition_key: 'w1' }, base);
    const stageName = 'temp.player_stats__breakdown';
    breakdownConn.execute(`CREATE TABLE ${stageName} AS SELECT * FROM player_stats WHERE 0;`);
    const stageOnly = time(() => {
      breakdownConn.execute(`DELETE FROM ${stageName};`);
      const perInsert = Math.max(1, Math.floor(999 / colList.length));
      const commands: Array<[string, Array<string | number | null>]> = [];
      for (let start = 0; start < base.length; start += perInsert) {
        const group = base.slice(start, start + perInsert);
        const params: Array<string | number | null> = [];
        for (const row of group) for (const column of colList) params.push(row[column] ?? null);
        commands.push([`INSERT INTO ${stageName} (${colList.join(', ')}) VALUES ${group.map(() => `(${colList.map(() => '?').join(', ')})`).join(', ')};`, params]);
      }
      runBatch(breakdownConn, commands);
    });
    const diffOnly = time(() => {
      breakdownConn.execute(
        `SELECT count(*) FROM ${stageName} s LEFT JOIN player_stats m ON m.partition_key = s.partition_key AND m.stat_uid = s.stat_uid ` +
          `WHERE m.rowid IS NULL OR (${colList.map((c) => `m.${c}`).join(', ')}) IS NOT (${colList.map((c) => `s.${c}`).join(', ')});`,
      );
    });
    // eslint-disable-next-line no-console
    console.log(`\nunchanged write, broken down: staging ${stageOnly.toFixed(1)} ms, diff ${diffOnly.toFixed(1)} ms`);
    breakdownConn.close();

    const lines = Object.entries(results).map(
      ([label, { legacy, changeSet }]) =>
        `${label.padEnd(20)} legacy ${legacy.toFixed(1).padStart(7)} ms   change-set ${changeSet.toFixed(1).padStart(7)} ms   ratio ${(changeSet / legacy).toFixed(2)}`,
    );
    // eslint-disable-next-line no-console
    console.log(`\n${lines.join('\n')}`);
    expect(Object.keys(results)).toHaveLength(4);
  });
});
