import { installTestRuntime } from '../testing/runtime';
import { createMemoryRowTable } from '../table/memory';
import { RowTable, RowTableSchema } from '../table/types';
import { createVersionAtom } from '../reactivity/version_atom';
import { definePartitions } from '../define_partitions';
import { reportStoreDegradation } from '../diagnostics/telemetry';

jest.mock('../diagnostics/telemetry', () => ({ reportStoreDegradation: jest.fn() }));

const invalidateMock = installTestRuntime().invalidateQueries;
const degradeMock = reportStoreDegradation as jest.Mock;

type GameRow = { sport: string; season: string; season_type: string; game_id: string };
type GameKey = { sport: string; season: string; seasonType: string };

const SCHEMA: RowTableSchema<GameRow> = {
  table: 'games',
  columns: {
    sport: { type: 'TEXT' },
    season: { type: 'TEXT' },
    season_type: { type: 'TEXT' },
    game_id: { type: 'TEXT' },
  },
  primaryKey: ['sport', 'season', 'season_type', 'game_id'],
  meta: { table: 'games_meta', keyColumns: ['sport', 'season', 'season_type'], column: 'etag' },
};

const NFL: GameKey = { sport: 'nfl', season: '2025', seasonType: 'regular' };
const OTHER: GameKey = { ...NFL, season: '2024' };

function makeGames(over: { table?: RowTable<GameRow>; parse?: (key: GameKey, raw: string) => GameRow[]; body?: string; internMax?: number } = {}) {
  const table = over.table ?? createMemoryRowTable(SCHEMA);
  table.init();
  const version = createVersionAtom('define_partitions_test');
  const changed: { key: GameKey; version: number }[] = [];
  const body = over.body ?? '["g1","g2"]';
  // Typed loosely: the assertions below inspect the arity of each call, which a tuple type hides.
  const query = jest.fn((..._args: unknown[]) => ({ queryFn: async () => ({ data: body, etag: 'W/"v1"' }) }));

  const games = definePartitions<GameRow, GameKey>({
    name: 'games',
    table,
    version,
    key: {
      fields: ['sport', 'season', 'seasonType'],
      where: ({ sport, season, seasonType }) => ({ sport, season, season_type: seasonType }),
    },
    fetch: {
      query,
      parse:
        over.parse ??
        ((key, raw) => (JSON.parse(raw) as string[]).map((id) => ({ sport: key.sport, season: key.season, season_type: key.seasonType, game_id: id }))),
    },
    onChanged: (key, version) => changed.push({ key, version: version }),
    internMax: over.internMax,
  });

  return { games, table, version, changed, query };
}

beforeEach(() => {
  invalidateMock.mockClear();
  degradeMock.mockClear();
});

describe('definePartitions — `key.where` is the one fact the rest is derived from', () => {
  it('keeps the ETag under the partition it belongs to, so a second partition still fetches cold', async () => {
    const harness = makeGames();

    await harness.games.lifecycle.fetch(NFL);

    expect(harness.table.getMeta({ sport: 'nfl', season: '2025', season_type: 'regular' })).toBe('W/"v1"');
    expect(harness.table.getMeta({ sport: 'nfl', season: '2024', season_type: 'regular' })).toBeUndefined();
  });

  it('sends the stored ETag back on the next fetch, which is what makes a 304 possible', async () => {
    const harness = makeGames();

    await harness.games.lifecycle.fetch(NFL);
    await harness.games.lifecycle.fetch(NFL);

    // `query` is also consulted for its staleTime with one argument; the fetching calls are the two-argument ones.
    const etags = harness.query.mock.calls.filter((call) => call.length === 2).map((call) => call[1]);
    expect(etags).toEqual([undefined, 'W/"v1"']);
    harness.query.mock.calls.forEach((call) => expect(call[0]).toEqual(NFL));
  });

  it('answers `has` from the same rows, so presence and ingest cannot disagree', async () => {
    const harness = makeGames();

    expect(harness.games.has(NFL)).toBe(false);
    await harness.games.lifecycle.fetch(NFL);
    expect(harness.games.has(NFL)).toBe(true);
    expect(harness.games.has({ ...NFL, season: '2024' })).toBe(false);
  });

  it('replaces only its own partition, leaving a sibling in place', async () => {
    const harness = makeGames();
    await harness.games.lifecycle.fetch(NFL);
    await harness.games.lifecycle.fetch(OTHER);

    expect(harness.table.find(harness.games.where(NFL))).toHaveLength(2);
    expect(harness.table.find(harness.games.where(OTHER))).toHaveLength(2);
  });

  it('clears the ETag on request, so the next fetch is a real one rather than a 304', async () => {
    const harness = makeGames();
    await harness.games.lifecycle.fetch(NFL);

    harness.games.clearEtag(NFL);

    expect(harness.table.getMeta(harness.games.where(NFL))).toBeUndefined();
  });
});

describe('definePartitions — bumping', () => {
  it('raises the version once rows land and tells `onChanged`, for a store holding a derived rollup', async () => {
    const harness = makeGames();

    await harness.games.lifecycle.fetch(NFL);

    expect(harness.games.versionOf(NFL)).toBe(1);
    expect(harness.changed).toEqual([{ key: NFL, version: 1 }]);
  });

  it('bumps a partition a writer filled itself, which is how a socket frame wakes readers', () => {
    const harness = makeGames();

    expect(harness.games.bump(NFL)).toBe(1);
    expect(harness.games.versionOf(NFL)).toBe(1);
    expect(harness.changed).toHaveLength(1);
  });

  it('keys the version by the field order it declared, so two partitions never share one', () => {
    const harness = makeGames();

    harness.games.bump(NFL);

    expect(harness.games.versionOf(NFL)).toBe(1);
    expect(harness.games.versionOf({ ...NFL, seasonType: 'post' })).toBe(0);
  });
});

describe('definePartitions — the shred, and what happens when it cannot run', () => {
  it('re-parses in JS and reports a degradation when the raw shred throws, rather than losing the partition', async () => {
    const memory = createMemoryRowTable(SCHEMA);
    memory.init();
    const table: RowTable<GameRow> = {
      ...memory,
      shred: jest.fn(async () => {
        throw new Error('native shred failed');
      }),
      overwrite: jest.fn(memory.overwrite),
    };
    const harness = makeGames({ table });

    await harness.games.lifecycle.fetch(NFL);

    expect(table.overwrite).toHaveBeenCalled();
    expect(memory.find(harness.games.where(NFL))).toHaveLength(2);
    expect(degradeMock).toHaveBeenCalledWith(expect.objectContaining({ scope: 'games_store.raw_ingest' }));
  });

  it('skips the raw shred entirely for a body it is told cannot be iterated', async () => {
    const memory = createMemoryRowTable(SCHEMA);
    memory.init();
    const table: RowTable<GameRow> = { ...memory, shred: jest.fn(memory.shred), overwrite: jest.fn(memory.overwrite) };
    const version = createVersionAtom('define_partitions_no_shred');
    const games = definePartitions<GameRow, GameKey>({
      name: 'games',
      table,
      version,
      key: { fields: ['sport', 'season', 'seasonType'], where: ({ sport, season, seasonType }) => ({ sport, season, season_type: seasonType }) },
      fetch: {
        query: () => ({ queryFn: async () => ({ data: '{"only":"one"}' }) }),
        parse: (key) => [{ sport: key.sport, season: key.season, season_type: key.seasonType, game_id: 'one' }],
        canShredNatively: () => false,
      },
    });

    await games.lifecycle.fetch(NFL);

    expect(table.shred).not.toHaveBeenCalled();
    expect(table.overwrite).toHaveBeenCalled();
    expect(degradeMock).not.toHaveBeenCalled();
  });

  it('records when rows landed, so a store needs no fetch bookkeeping of its own', async () => {
    const harness = makeGames();
    expect(harness.games.lifecycle.getFetchedAt(NFL)).toBe(0);

    await harness.games.lifecycle.fetch(NFL);

    expect(harness.games.lifecycle.getFetchedAt(NFL)).toBeGreaterThan(0);
    expect(harness.games.lifecycle.getFetchedAt(OTHER)).toBe(0);
  });

  it('forgets the oldest fetch record past its bound, which reads as never fetched', async () => {
    const harness = makeGames({ internMax: 2 });
    const third: GameKey = { ...NFL, season: '2023' };

    await harness.games.lifecycle.fetch(NFL);
    await harness.games.lifecycle.fetch(OTHER);
    await harness.games.lifecycle.fetch(third);

    expect(harness.games.lifecycle.getFetchedAt(NFL)).toBe(0);
    expect(harness.games.lifecycle.getFetchedAt(OTHER)).toBeGreaterThan(0);
    expect(harness.games.lifecycle.getFetchedAt(third)).toBeGreaterThan(0);
  });

  it('leaves `getFetchedAt` where it was on a 304, since a matched ETag lands no rows', async () => {
    const harness = makeGames();
    await harness.games.lifecycle.fetch(NFL);
    const first = harness.games.lifecycle.getFetchedAt(NFL);

    harness.query.mockReturnValue({ queryFn: async () => ({ __etagMatch: true } as unknown as { data: string; etag: string }) });
    harness.games.lifecycle.invalidate(NFL);
    await harness.games.lifecycle.fetch(NFL);

    expect(harness.games.lifecycle.getFetchedAt(NFL)).toBe(first);
  });
});

describe('definePartitions — reads take the key rather than a positional array', () => {
  it('defaults a read to the key fields, so a read whose args include them declares no partition', async () => {
    const harness = makeGames();
    const ids = harness.games.read<GameKey, string[]>()({
      select: (_args, key) => harness.table.find(harness.games.where(key)).map((row) => row.game_id),
      empty: [],
    });
    await harness.games.lifecycle.fetch(NFL);

    // `team` sits outside the key's fields, so it is dropped and the read still addresses the one partition.
    expect(ids.getValue({ ...NFL, team: 'SF' } as GameKey)).toEqual(['g1', 'g2']);
  });

  it('gates a read on the partition holding rows, so `select` never runs against an empty one', () => {
    const harness = makeGames();
    const select = jest.fn(() => ['x']);
    const ids = harness.games.read<GameKey, string[]>()({ select, empty: [] });

    expect(ids.getValue(NFL)).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('hands `select` the same key `where` is written against', async () => {
    const harness = makeGames();
    const seen: GameKey[] = [];
    const ids = harness.games.read<GameKey, string[]>()({
      select: (_args, key) => {
        seen.push(key);
        return [];
      },
      empty: [],
    });
    await harness.games.lifecycle.fetch(NFL);
    ids.getValue(NFL);

    expect(seen).toEqual([NFL]);
  });
});

describe('definePartitions — a store whose key is an opaque string', () => {
  type BlobRow = { partition_key: string; id: string };
  const BLOB_SCHEMA: RowTableSchema<BlobRow> = {
    table: 'blobs',
    columns: { partition_key: { type: 'TEXT' }, id: { type: 'TEXT' } },
    primaryKey: ['partition_key', 'id'],
    meta: { table: 'blobs_meta', keyColumns: ['partition_key'], column: 'etag' },
  };

  const makeBlobs = () => {
    const table = createMemoryRowTable(BLOB_SCHEMA);
    table.init();
    const version = createVersionAtom('define_partitions_blob');
    const blobs = definePartitions<BlobRow, string>({
      name: 'blobs',
      table,
      version,
      key: { where: (key) => ({ partition_key: key }) },
      fetch: {
        query: () => ({ queryFn: async () => ({ data: '["a"]', etag: 'W/"b"' }) }),
        parse: (key, raw) => (JSON.parse(raw) as string[]).map((id) => ({ partition_key: key, id })),
      },
    });
    return { blobs, table };
  };

  it('needs no `fields`: the key is already one part, and everything derives from it as usual', async () => {
    const harness = makeBlobs();

    await harness.blobs.lifecycle.fetch('season|nfl|2025');

    expect(harness.table.getMeta({ partition_key: 'season|nfl|2025' })).toBe('W/"b"');
    expect(harness.blobs.has('season|nfl|2025')).toBe(true);
    expect(harness.blobs.versionOf('season|nfl|2025')).toBe(1);
  });

  it('addresses nothing with an empty key, so nothing is fetched for a partition that does not exist', async () => {
    const harness = makeBlobs();

    await harness.blobs.lifecycle.fetch('');

    expect(harness.table.has({ partition_key: '' })).toBe(false);
  });

  it('invalidates one partition by its key, without touching the store\u2019s others', () => {
    const harness = makeBlobs();

    harness.blobs.lifecycle.invalidate('season|nfl|2025');

    expect(invalidateMock).toHaveBeenCalledWith({ queryKey: ['blobs_store_ingest', 'season|nfl|2025'], exact: true });
  });
});

describe('definePartitions — a store whose partition is a record, interned to a key', () => {
  type StatRow = { partition_key: string; id: string };
  type Spec = { request: 'week' | 'game'; sport: string; week?: number };
  type Args = { partition: Spec };

  const STAT_SCHEMA: RowTableSchema<StatRow> = {
    table: 'stats',
    columns: { partition_key: { type: 'TEXT' }, id: { type: 'TEXT' } },
    primaryKey: ['partition_key', 'id'],
    meta: { table: 'stats_meta', keyColumns: ['partition_key'], column: 'etag' },
  };

  const specKey = (spec: Spec): string => `${spec.request}:${spec.sport}:${spec.week ?? ''}`;
  const WEEK1: Spec = { request: 'week', sport: 'nfl', week: 1 };

  function makeStats() {
    const table = createMemoryRowTable(STAT_SCHEMA);
    table.init();
    // Deduped: the ingest also consults `query` for staleTime, so a fetch reaches it more than once.
    const byKey = new Map<string, Spec>();
    const queried = { records: [] as Spec[] };
    const shredAsked: Spec[] = [];
    const stats = definePartitions<StatRow, string, Args, Spec>({
      name: 'stats',
      table,
      version: createVersionAtom(`define_partitions_intern_${Math.random()}`),
      key: { of: (args) => args.partition, id: specKey, where: (key) => ({ partition_key: key }) },
      fetch: {
        query: (partition) => {
          if (!byKey.has(specKey(partition))) {
            byKey.set(specKey(partition), partition);
            queried.records.push(partition);
          }
          return { queryFn: async () => ({ data: '["a","b"]' }) };
        },
        parse: (_partition, raw, key) => (JSON.parse(raw) as string[]).map((id) => ({ partition_key: key, id })),
        canShredNatively: (partition) => {
          shredAsked.push(partition);
          return false;
        },
      },
    });
    return { stats, table, queried: queried.records, shredAsked };
  }

  it('hands the fetch the record, so a store keeps no record-to-key table of its own', async () => {
    const harness = makeStats();

    await harness.stats.lifecycle.fetch({ partition: WEEK1 });

    expect(harness.queried).toEqual([WEEK1]);
    expect(harness.shredAsked).toEqual([WEEK1]);
  });

  it('addresses rows by the key the record hashes to', async () => {
    const harness = makeStats();

    await harness.stats.lifecycle.fetch({ partition: WEEK1 });

    expect(harness.table.find({ partition_key: 'week:nfl:1' }).map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('reaches the key through `key.of`, so a read over the record declares no partition', async () => {
    const harness = makeStats();
    const ids = harness.stats.read<Args, string[]>()({
      select: (_args, key) => harness.table.find({ partition_key: key }).map((row) => row.id),
      empty: [],
    });

    await harness.stats.lifecycle.fetch({ partition: WEEK1 });

    // A fresh object equal to `WEEK1`: the record's hash is what addresses the partition.
    expect(ids.getValue({ partition: { request: 'week', sport: 'nfl', week: 1 } })).toEqual(['a', 'b']);
  });

  it('interns the records a read names, so the read names partitions rather than keys', async () => {
    const harness = makeStats();
    const game: Spec = { request: 'game', sport: 'nfl' };
    const ids = harness.stats.readMany<{ specs: Spec[] }, string[]>()({
      partitions: (args) => args.specs,
      select: (_args, keys) => keys.flatMap((key) => harness.table.find({ partition_key: key }).map((row) => row.id)),
      empty: [],
    });

    ids.getValue({ specs: [WEEK1, game] });

    expect(harness.queried).toEqual([WEEK1, game]);
  });

  it('takes the partitions off args named `partitions`, so a read that spans the ones it was handed says nothing', async () => {
    const harness = makeStats();
    const ids = harness.stats.readMany<{ partitions: Spec[] }, string[]>()({
      select: (_args, keys) => keys.flatMap((key) => harness.table.find({ partition_key: key }).map((row) => row.id)),
      empty: [],
    });

    await harness.stats.lifecycle.fetch({ partition: WEEK1 });

    expect(ids.getValue({ partitions: [WEEK1] })).toEqual(['a', 'b']);
  });

  it('keeps an absent partition as a gap, so a result stays parallel to the list the caller named', async () => {
    const harness = makeStats();
    const seen = harness.stats.readMany<{ specs: (Spec | null)[] }, boolean[]>()({
      partitions: (args) => args.specs,
      select: (_args, keys) => keys.map(Boolean),
      empty: [],
    });

    await harness.stats.lifecycle.fetch({ partition: WEEK1 });
    harness.queried.length = 0;

    expect(seen.getValue({ specs: [WEEK1, null] })).toEqual([true, false]);
    expect(harness.queried).toEqual([]);
  });

  it('groups partitions parallel to what the caller asked about, so `select` does no index arithmetic', async () => {
    const harness = makeStats();
    const game: Spec = { request: 'game', sport: 'nfl' };
    const perPlayer = harness.stats.readGrouped<{ players: { candidates: Spec[] }[] }, number[]>()({
      groups: (args) => args.players.map((player) => player.candidates),
      select: (_args, groups) => groups.map((keys) => keys.reduce((total, key) => total + harness.table.find({ partition_key: key }).length, 0)),
      empty: [],
    });

    await harness.stats.lifecycle.fetch({ partition: WEEK1 });

    expect(perPlayer.getValue({ players: [{ candidates: [WEEK1, game] }, { candidates: [game] }] })).toEqual([2, 0]);
  });

  it('keeps a partition warm by re-interning it on every path that names it, rather than only at declaration', () => {
    const harness = makeStats();
    const game: Spec = { request: 'game', sport: 'nfl' };
    const ids = harness.stats.read<Args, string[]>()({ select: () => [], empty: [] });

    ids.getValue({ partition: WEEK1 });
    ids.getValue({ partition: game });
    ids.getValue({ partition: WEEK1 });

    expect(() => harness.stats.lifecycle.getVersion({ partition: WEEK1 })).not.toThrow();
    expect(() => harness.stats.lifecycle.getVersion({ partition: game })).not.toThrow();
  });

  it('takes args, not keys, throughout `lifecycle`, so a backend publishes the group as-is', async () => {
    const harness = makeStats();
    const args: Args = { partition: WEEK1 };

    expect(harness.stats.lifecycle.has(args)).toBe(false);
    await harness.stats.lifecycle.fetch(args);

    expect(harness.stats.lifecycle.has(args)).toBe(true);
    expect(harness.stats.lifecycle.getVersion(args)).toBe(1);
    expect(harness.stats.lifecycle.getFetchedAt(args)).toBeGreaterThan(0);
  });
});

describe('definePartitions — args that resolve to no partition at all', () => {
  type StatRow = { partition_key: string; id: string };
  type Spec = { sport: string; week: number };
  /** Args as a screen holds them, before the values that name a partition have arrived. */
  type Args = { sport?: string; week?: number };

  const SCHEMA: RowTableSchema<StatRow> = {
    table: 'loose',
    columns: { partition_key: { type: 'TEXT' }, id: { type: 'TEXT' } },
    primaryKey: ['partition_key', 'id'],
    meta: { table: 'loose_meta', keyColumns: ['partition_key'], column: 'etag' },
  };

  function makeLoose() {
    const table = createMemoryRowTable(SCHEMA);
    table.init();
    const queried: Spec[] = [];
    const loose = definePartitions<StatRow, string, Args, Spec>({
      name: 'loose',
      table,
      version: createVersionAtom(`define_partitions_loose_${Math.random()}`),
      key: {
        of: (args) => (args.sport && args.week ? { sport: args.sport, week: args.week } : null),
        id: (spec) => `${spec.sport}:${spec.week}`,
        where: (key) => ({ partition_key: key }),
      },
      fetch: {
        query: (partition) => {
          queried.push(partition);
          return { queryFn: async () => ({ data: '["a"]' }) };
        },
        parse: (_partition, raw, key) => (JSON.parse(raw) as string[]).map((id) => ({ partition_key: key, id })),
        canShredNatively: () => false,
      },
    });
    const ids = loose.read<Args, string[]>()({
      select: (_args, key) => table.find({ partition_key: key }).map((row) => row.id),
      empty: [],
    });
    return { loose, table, queried, ids };
  }

  it('reads as empty and fetches nothing while a value that names the partition is missing', () => {
    const harness = makeLoose();

    expect(harness.ids.getValue({ sport: 'nfl' })).toEqual([]);
    expect(harness.queried).toEqual([]);
  });

  it('reads the partition once the missing value arrives, so the same args resolve when they are complete', async () => {
    const harness = makeLoose();

    await harness.loose.lifecycle.fetch({ sport: 'nfl', week: 1 });

    expect(harness.ids.getValue({ sport: 'nfl', week: 1 })).toEqual(['a']);
    expect(harness.queried).toContainEqual({ sport: 'nfl', week: 1 });
  });

  it('leaves every lifecycle member inert, rather than asking about a partition that has no address', async () => {
    const harness = makeLoose();
    const partial: Args = { sport: 'nfl' };
    invalidateMock.mockClear();

    await harness.loose.lifecycle.fetch(partial);
    harness.loose.lifecycle.invalidate(partial);

    expect(harness.loose.lifecycle.has(partial)).toBe(false);
    expect(harness.loose.lifecycle.getVersion(partial)).toBe(0);
    expect(harness.loose.lifecycle.getFetchedAt(partial)).toBe(0);
    expect(harness.queried).toEqual([]);
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});
