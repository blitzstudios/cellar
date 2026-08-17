import { configureDataKernel, INERT_ERRORS } from '../../runtime';
import { BatchCommand, readRows, SqliteConnection } from '../../table/connection';
import { createMemoryRowTable } from '../../table/memory';
import { columnNames, RowTableSchema } from '../../table/types';
import { addedColumns, LiveColumn, LiveSchema, planSchemaMigration, schemaFingerprint, schemaStructureStamp } from '../../table/schema';
import { createSqliteRowTable } from '../../table/sqlite';
import { itDev, itProd } from '../../testing/dev_mode';
import type { NativeShredSpec, ShredOp } from '../../write/shred_spec';
import { resetOnceGuards } from '../../diagnostics/once_guard';
import { createSqlJsConnection, initSqlJs } from '../../testing/sqljs_connection';

type TestRow = {
  id: string;
  sport: string;
  team: string | null;
  num: number | null;
};

function last<T>(arr: readonly T[]): T | undefined {
  return arr[arr.length - 1];
}

const schema: RowTableSchema<TestRow> = {
  table: 'things',
  columns: {
    id: { type: 'TEXT', notNull: true },
    sport: { type: 'TEXT', notNull: true },
    team: { type: 'TEXT' },
    num: { type: 'INTEGER' },
  },
  primaryKey: ['sport', 'id'],
  indexes: [{ name: 'idx_things_team', columns: ['sport', 'team'] }],
  meta: { table: 'things_meta', keyColumns: ['sport'], column: 'etag' },
};

function row(id: string, sport: string, team: string | null, num: number | null): TestRow {
  return { id, sport, team, num };
}

describe('row_table — memory backend', () => {
  it('overwrite replaces a scope, and reads project by equality', () => {
    const db = createMemoryRowTable(schema);
    db.overwrite({ sport: 'nfl' }, [row('a', 'nfl', 'NE', 2), row('b', 'nfl', 'NE', 1), row('c', 'nfl', 'KC', 3)]);
    db.overwrite({ sport: 'nba' }, [row('x', 'nba', 'BOS', 9)]);

    expect(db.getOne({ sport: 'nfl', id: 'b' })).toEqual(row('b', 'nfl', 'NE', 1));
    expect(
      db
        .find({ sport: 'nfl', team: 'NE' })
        .map((row) => row.id)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(db.find({ sport: 'nba' })).toHaveLength(1);

    db.overwrite({ sport: 'nfl' }, [row('z', 'nfl', 'KC', 5)]);
    expect(db.find({ sport: 'nfl' }).map((row) => row.id)).toEqual(['z']);
    expect(db.find({ sport: 'nba' })).toHaveLength(1);
  });

  it('find orderBy sorts ascending (numeric)', () => {
    const db = createMemoryRowTable(schema);
    db.overwrite({ sport: 'nfl' }, [row('a', 'nfl', 'NE', 3), row('b', 'nfl', 'NE', 1), row('c', 'nfl', 'NE', 2)]);
    expect(db.find({ sport: 'nfl' }, { orderBy: 'num' }).map((row) => row.id)).toEqual(['b', 'c', 'a']);
  });

  it('findIn returns rows for scope + IN, unordered', () => {
    const db = createMemoryRowTable(schema);
    db.overwrite({ sport: 'nfl' }, [row('a', 'nfl', 'NE', 1), row('b', 'nfl', 'KC', 2), row('c', 'nfl', 'KC', 3)]);
    const got = db
      .findIn({ sport: 'nfl' }, 'id', ['c', 'a'])
      .map((row) => row.id)
      .sort();
    expect(got).toEqual(['a', 'c']);
    expect(db.findIn({ sport: 'nfl' }, 'id', [])).toEqual([]);
  });

  it('upsert replaces by primary key', async () => {
    const db = createMemoryRowTable(schema);
    await db.upsert([row('a', 'nfl', 'NE', 1)]);
    await db.upsert([row('a', 'nfl', 'NE', 99)]);
    await db.upsert([row('a', 'nba', 'BOS', 1)]);
    expect(db.getOne({ sport: 'nfl', id: 'a' })?.num).toBe(99);
    expect(db.find({}).length).toBe(2);
  });

  it('has is true immediately after overwrite (even empty), else reflects data', () => {
    const db = createMemoryRowTable(schema);
    expect(db.has({ sport: 'nfl' })).toBe(false);
    db.overwrite({ sport: 'nfl' }, []);
    expect(db.has({ sport: 'nfl' })).toBe(true);
  });

  it('meta get/set by scope', () => {
    const db = createMemoryRowTable(schema);
    expect(db.getMeta({ sport: 'nfl' })).toBeUndefined();
    db.setMeta({ sport: 'nfl' }, 'etag-123');
    expect(db.getMeta({ sport: 'nfl' })).toBe('etag-123');
    expect(db.getMeta({ sport: 'nba' })).toBeUndefined();
  });

  it('clears the entry on undefined', () => {
    const db = createMemoryRowTable(schema);
    db.setMeta({ sport: 'nfl' }, 'etag-123');
    db.setMeta({ sport: 'nfl' }, undefined);
    expect(db.getMeta({ sport: 'nfl' })).toBeUndefined();
  });
});

function makeConn(): {
  conn: SqliteConnection;
  calls: Array<{ sql: string; params?: ReadonlyArray<string | number | null> }>;
  batches: BatchCommand[][];
  setReader: (fn: (sql: string, params?: ReadonlyArray<string | number | null>) => unknown[]) => void;
} {
  const calls: Array<{ sql: string; params?: ReadonlyArray<string | number | null> }> = [];
  const batches: BatchCommand[][] = [];
  let reader: (sql: string, params?: ReadonlyArray<string | number | null>) => unknown[] = () => [];
  const conn: SqliteConnection = {
    execute(sql, params) {
      calls.push({ sql, params });
      return { rows: { _array: reader(sql, params) } };
    },
    executeBatch(commands) {
      batches.push(commands.map((command) => [command[0], command[1]] as BatchCommand));
    },
  };
  return {
    conn,
    calls,
    batches,
    setReader: (fn) => {
      reader = fn;
    },
  };
}

describe('row_table — sqlite backend (generated SQL)', () => {
  it('init generates CREATE TABLE (with PK), indexes, and the meta table', () => {
    const { conn, calls } = makeConn();
    createSqliteRowTable(schema, conn).init();
    const sql = calls.map((call) => call.sql).join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS things');
    expect(sql).toContain('id TEXT NOT NULL');
    expect(sql).toContain('num INTEGER');
    expect(sql).toContain('PRIMARY KEY (sport, id)');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_things_team ON things (sport, team)');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS things_meta');
  });

  /**
   * A `setReader` fn answering the three PRAGMAs `init` plans from, with `live` standing for the table already on disk:
   * its columns, and the two stamps a build of it would have left.
   */
  const readerFor = (live: RowTableSchema<any> | undefined, stamp: number, structure = 0) => (sql: string) => {
    if (sql.startsWith('PRAGMA table_info')) {
      return live ? columnNames(live).map((name) => ({ name, type: live.columns[name].type, notnull: live.columns[name].notNull ? 1 : 0 })) : [];
    }
    if (sql.startsWith('PRAGMA user_version')) return [{ user_version: stamp }];
    if (sql.startsWith('PRAGMA application_id')) return [{ application_id: structure }];
    return [];
  };

  /** The reader for a database holding exactly what `built` declares, which is the upgrade case every plan starts from. */
  const reader = (built: RowTableSchema<any> | undefined, spec?: NativeShredSpec) =>
    built ? readerFor(built, schemaFingerprint(built, spec), schemaStructureStamp(built, spec)) : readerFor(undefined, 0);

  /** What a live database holds, as `PRAGMA table_info` reports it. */
  const liveOf = (built: RowTableSchema<any>): LiveColumn[] =>
    columnNames(built).map((name) => ({ name, type: built.columns[name].type, notnull: built.columns[name].notNull ? 1 : 0 }));

  /** The whole live account of a database built from `built`, for a planner call. */
  const liveSchema = (built: RowTableSchema<any>, spec?: NativeShredSpec): LiveSchema => ({
    columns: liveOf(built),
    stamp: schemaFingerprint(built, spec),
    structure: schemaStructureStamp(built, spec),
  });

  describe('schema fingerprint (PRAGMA user_version)', () => {
    it('is the whole migration decision: create when absent, none when current, rebuild otherwise', () => {
      const live = liveSchema(schema);
      expect(planSchemaMigration(schema, { ...live, columns: [] })).toBe('create');
      expect(planSchemaMigration(schema, live)).toBe('none');
      expect(planSchemaMigration(schema, { ...live, stamp: live.stamp + 1, structure: live.structure + 1 })).toBe('rebuild');
    });

    it.each([
      ['a retyped column', (schema: RowTableSchema<TestRow>) => ({ ...schema, columns: { ...schema.columns, num: { type: 'TEXT' as const } } })],
      [
        'a dropped column',
        (schema: RowTableSchema<TestRow>) => ({ ...schema, columns: { id: schema.columns.id, sport: schema.columns.sport, team: schema.columns.team } }),
      ],
      ['a changed primary key', (schema: RowTableSchema<TestRow>) => ({ ...schema, primaryKey: ['id'] })],
      ['a changed index', (schema: RowTableSchema<TestRow>) => ({ ...schema, indexes: [{ name: 'idx_things_team', columns: ['sport', 'num'] }] })],
      ['a renamed meta table', (schema: RowTableSchema<TestRow>) => ({ ...schema, meta: { ...schema.meta!, table: 'things_etags' } })],
      ['a bumped rebuildVersion', (schema: RowTableSchema<TestRow>) => ({ ...schema, rebuildVersion: 2 })],
    ])('changes on %s', (_label, mutate) => {
      expect(schemaFingerprint(mutate(schema) as RowTableSchema<TestRow>)).not.toBe(schemaFingerprint(schema));
    });

    describe('the shred spec is part of it', () => {
      const spec = (op: ShredOp): NativeShredSpec => ({
        specs: { all: { version: 1, table: 'things', insertVerb: 'INSERT OR REPLACE', columns: ['sport'], ops: [op], deleteWhere: [] } },
        variant: () => 'all',
        binds: () => [],
      });

      it('changes when a column is filled from a different path', () => {
        expect(schemaFingerprint(schema, spec({ op: 'text', path: 'sport' }))).not.toBe(schemaFingerprint(schema, spec({ op: 'text', path: 'league' })));
      });

      it('changes when a column is filled by a different op, which is the edit that keeps the column and moves its meaning', () => {
        expect(schemaFingerprint(schema, spec({ op: 'text', path: 'sport' }))).not.toBe(schemaFingerprint(schema, spec({ op: 'rawJsonField', path: 'sport' })));
      });

      it('changes when one variant of many changes, since a scope shreds through exactly one of them', () => {
        const base = spec({ op: 'text', path: 'sport' });
        const twoVariants: NativeShredSpec = { ...base, specs: { ...base.specs, nfl: { ...base.specs.all, ops: [{ op: 'int', path: 'sport' }] } } };
        const edited: NativeShredSpec = { ...base, specs: { ...twoVariants.specs, nfl: { ...base.specs.all, ops: [{ op: 'real', path: 'sport' }] } } };

        expect(schemaFingerprint(schema, twoVariants)).not.toBe(schemaFingerprint(schema, edited));
      });

      it('is insensitive to variant declaration order, which selects the same spec either way', () => {
        const base = spec({ op: 'text', path: 'sport' });
        const nfl = { ...base.specs.all, ops: [{ op: 'int' as const, path: 'sport' }] };
        const oneWay: NativeShredSpec = { ...base, specs: { all: base.specs.all, nfl } };
        const other: NativeShredSpec = { ...base, specs: { nfl, all: base.specs.all } };

        expect(schemaFingerprint(schema, oneWay)).toBe(schemaFingerprint(schema, other));
      });

      it('differs from having no spec at all, so adding a native shred is itself a rebuild', () => {
        expect(schemaFingerprint(schema, spec({ op: 'text', path: 'sport' }))).not.toBe(schemaFingerprint(schema));
      });
    });

    it('is insensitive to index declaration order, which does not change what gets built', () => {
      const two: RowTableSchema<TestRow> = {
        ...schema,
        indexes: [
          { name: 'idx_a', columns: ['sport'] },
          { name: 'idx_b', columns: ['team'] },
        ],
      };
      const swapped: RowTableSchema<TestRow> = { ...two, indexes: [two.indexes![1], two.indexes![0]] };
      expect(schemaFingerprint(swapped)).toBe(schemaFingerprint(two));
    });

    it('never returns the 0 an unstamped database reads as, and fits the signed 32 bits the PRAGMA holds', () => {
      for (const variant of [schema, { ...schema, rebuildVersion: 9 }, { ...schema, table: 'other' }]) {
        const fp = schemaFingerprint(variant as RowTableSchema<TestRow>);
        expect(fp).not.toBe(0);
        expect(Number.isInteger(fp)).toBe(true);
        expect(fp).toBeGreaterThanOrEqual(-(2 ** 31));
        expect(fp).toBeLessThanOrEqual(2 ** 31 - 1);
      }
    });

    it('stamps the fingerprint after creating a table', () => {
      const { conn, calls } = makeConn();
      createSqliteRowTable(schema, conn).init();
      expect(last(calls)?.sql).toBe(`PRAGMA user_version = ${schemaFingerprint(schema)};`);
    });

    it('leaves a current table alone, without even a redundant stamp write', () => {
      const { conn, calls, setReader } = makeConn();
      setReader(reader(schema) as never);
      createSqliteRowTable(schema, conn).init();
      expect(calls.some((column) => column.sql.startsWith('DROP TABLE'))).toBe(false);
      expect(calls.some((column) => column.sql.startsWith('PRAGMA user_version ='))).toBe(false);
      expect(calls.some((column) => column.sql.startsWith('PRAGMA application_id ='))).toBe(false);
    });

    it('rebuilds an index change, the one case nothing else could detect', () => {
      const reindexed: RowTableSchema<TestRow> = { ...schema, indexes: [{ name: 'idx_things_team', columns: ['sport', 'num'] }] };

      const { conn, calls, setReader } = makeConn();
      setReader(reader(schema) as never);
      createSqliteRowTable(reindexed, conn).init();
      const sql = calls.map((column) => column.sql);
      expect(sql).toContain('DROP TABLE IF EXISTS things;');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_things_team ON things (sport, num);');
      expect(sql).toContain('DROP TABLE IF EXISTS things_meta;');
      expect(last(calls)?.sql).toBe(`PRAGMA user_version = ${schemaFingerprint(reindexed)};`);
    });
  });

  describe('a widening (PRAGMA application_id)', () => {
    /** The routine edit: a generated column set gains one, which is what a sport publishing a new stat looks like. */
    const widened: RowTableSchema<TestRow & { extra: string | null }> = { ...schema, columns: { ...schema.columns, extra: { type: 'TEXT' } } };

    it('is planned where only the columns grew, and the structure stamp agrees the rest is untouched', () => {
      expect(planSchemaMigration(widened, liveSchema(schema))).toBe('extend');
      expect(addedColumns(widened, liveOf(schema))).toEqual(['extra']);
    });

    it.each([
      ['a retyped column', { ...widened, columns: { ...widened.columns, num: { type: 'TEXT' as const } } }],
      ['a column that became NOT NULL', { ...widened, columns: { ...widened.columns, num: { type: 'INTEGER' as const, notNull: true } } }],
      ['a dropped column', { ...widened, columns: { id: schema.columns.id, sport: schema.columns.sport, extra: { type: 'TEXT' as const } } }],
      ['a new NOT NULL column, which every existing row would violate', { ...widened, columns: { ...widened.columns, extra: { type: 'TEXT' as const, notNull: true } } }],
    ])('falls back to a rebuild on %s, which no ALTER TABLE could apply', (_label, next) => {
      expect(planSchemaMigration(next as RowTableSchema<any>, liveSchema(schema))).toBe('rebuild');
      expect(addedColumns(next as RowTableSchema<any>, liveOf(schema))).toBeUndefined();
    });

    it.each([
      ['a changed index', { ...widened, indexes: [{ name: 'idx_things_team', columns: ['sport', 'num'] }] }],
      ['a changed primary key', { ...widened, primaryKey: ['id'] }],
      ['a renamed ETag table', { ...widened, meta: { ...schema.meta!, table: 'things_etags' } }],
      ['a bumped rebuildVersion', { ...widened, rebuildVersion: 2 }],
    ])('falls back to a rebuild on %s, which restates the rows already stored', (_label, next) => {
      expect(planSchemaMigration(next as RowTableSchema<any>, liveSchema(schema))).toBe('rebuild');
    });

    it('falls back to a rebuild when a shred op fills a column it already had from somewhere else', () => {
      const spec = (path: string): NativeShredSpec => ({
        specs: { all: { version: 1, table: 'things', insertVerb: 'INSERT OR REPLACE', columns: ['team'], ops: [{ op: 'text', path }], deleteWhere: [] } },
        variant: () => 'all',
        binds: () => [],
      });

      expect(planSchemaMigration(widened, liveSchema(schema, spec('team')), spec('team'))).toBe('extend');
      expect(planSchemaMigration(widened, liveSchema(schema, spec('team')), spec('roster_team'))).toBe('rebuild');
    });

    it('rebuilds a database stamped before the structure stamp existed, which is every install that predates it', () => {
      expect(planSchemaMigration(widened, { columns: liveOf(schema), stamp: schemaFingerprint(schema), structure: 0 })).toBe('rebuild');
    });

    it('adds the column and clears the etags, keeping the table and every row in it', () => {
      const { conn, calls, setReader } = makeConn();
      setReader(reader(schema) as never);
      createSqliteRowTable(widened, conn).init();
      const sql = calls.map((column) => column.sql);

      expect(sql).toContain('ALTER TABLE things ADD COLUMN extra TEXT;');
      expect(sql.some((statement) => statement.startsWith('DROP TABLE'))).toBe(false);
      // The added column is NULL in every row that predates it, so the fetch that fills it must not be 304'd away.
      expect(sql).toContain('DELETE FROM things_meta;');
      // Only the column list moved, so the structure stamp on disk already describes this schema.
      expect(schemaStructureStamp(widened)).toBe(schemaStructureStamp(schema));
      expect(sql.some((statement) => statement.startsWith('PRAGMA application_id ='))).toBe(false);
      expect(last(calls)?.sql).toBe(`PRAGMA user_version = ${schemaFingerprint(widened)};`);
    });

    it('stamps the structure of a table it left alone, so a database that predates the stamp can widen next time', () => {
      const { conn, calls, setReader } = makeConn();
      setReader(readerFor(schema, schemaFingerprint(schema), 0) as never);
      createSqliteRowTable(schema, conn).init();
      const sql = calls.map((column) => column.sql);

      expect(sql).toContain(`PRAGMA application_id = ${schemaStructureStamp(schema)};`);
      expect(sql.some((statement) => statement.startsWith('DROP TABLE'))).toBe(false);
      expect(sql.some((statement) => statement.startsWith('PRAGMA user_version ='))).toBe(false);
    });
  });

  describe('pushFed — a rebuild empties rows a fetch will not all bring back', () => {
    const pushSchema: RowTableSchema<TestRow> = { ...schema, table: 'pushy', pushFed: true, meta: undefined };
    /** A rebuild's worth of change: an index the rows are not sorted by, which no widening can apply. */
    const reindexed: RowTableSchema<TestRow> = { ...pushSchema, indexes: [{ name: 'idx_things_team', columns: ['sport', 'num'] }] };

    const withSentry = (assert: (sentry: { captureException: jest.Mock; captureMessage: jest.Mock }) => void): void => {
      const sentry = { captureException: jest.fn(), captureMessage: jest.fn() };
      configureDataKernel({ errors: sentry });
      resetOnceGuards();
      // The report is sampled, so an unlucky roll would otherwise decide whether this test sees it.
      const random = jest.spyOn(Math, 'random').mockReturnValue(0);
      try {
        assert(sentry);
      } finally {
        random.mockRestore();
        configureDataKernel({ errors: INERT_ERRORS });
      }
    };

    /**
     * The rebuild has to happen on every build, dev included. `init` stamps the schema last, so a dev build that threw
     * instead would leave the stale stamp on disk and take the in-memory backend again on the next launch, and the one
     * after — permanently slower than the heap it replaced, over a change someone shipped on purpose.
     */
    it('rebuilds rather than refusing to, so the database is never left stale for the next launch to trip over', () => {
      const { conn, calls, setReader } = makeConn();
      setReader(reader(pushSchema) as never);

      expect(() => createSqliteRowTable(reindexed, conn).init()).not.toThrow();

      expect(calls.some((column) => column.sql.startsWith('DROP TABLE'))).toBe(true);
      expect(last(calls)?.sql).toBe(`PRAGMA user_version = ${schemaFingerprint(reindexed)};`);
    });

    it('files it as a notice and not an error, since shipping a schema change is not a malfunction', () => {
      withSentry((sentry) => {
        const { conn, setReader } = makeConn();
        setReader(reader(pushSchema) as never);

        createSqliteRowTable(reindexed, conn).init();

        expect(sentry.captureException).not.toHaveBeenCalled();
        expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
        expect(sentry.captureMessage.mock.calls[0][1].level).toBe('info');
        expect(sentry.captureMessage.mock.calls[0][1].tags).toEqual({ off_heap_degradation: 'pushy.schema_rebuild' });
      });
    });

    it('does not fire on a widening, which keeps every row the pushes wrote', () => {
      withSentry((sentry) => {
        const widened: RowTableSchema<TestRow & { extra: string | null }> = { ...pushSchema, columns: { ...pushSchema.columns, extra: { type: 'TEXT' } } };
        const { conn, calls, setReader } = makeConn();
        setReader(reader(pushSchema) as never);

        createSqliteRowTable(widened, conn).init();

        expect(calls.map((column) => column.sql)).toContain('ALTER TABLE pushy ADD COLUMN extra TEXT;');
        expect(sentry.captureMessage).not.toHaveBeenCalled();
        expect(sentry.captureException).not.toHaveBeenCalled();
      });
    });

    it('does not fire on a first install, where there is nothing to lose', () => {
      withSentry((sentry) => {
        const { conn, setReader } = makeConn();
        setReader(reader(undefined) as never);
        createSqliteRowTable(pushSchema, conn).init();
        expect(sentry.captureMessage).not.toHaveBeenCalled();
      });
    });

    it('does not fire on an unchanged schema, so the guard costs a matching store nothing', () => {
      withSentry((sentry) => {
        const { conn, setReader } = makeConn();
        setReader(reader(pushSchema) as never);
        createSqliteRowTable(pushSchema, conn).init();
        expect(sentry.captureMessage).not.toHaveBeenCalled();
      });
    });
  });

  it('overwrite emits DELETE(scope) + one grouped INSERT OR REPLACE in one batch, and marks has()', () => {
    const { conn, batches } = makeConn();
    const db = createSqliteRowTable(schema, conn);
    db.overwrite({ sport: 'nfl' }, [row('a', 'nfl', 'NE', 2), row('b', 'nfl', 'KC', 1)]);
    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(batch[0][0]).toBe('DELETE FROM things WHERE sport = ?;');
    expect(batch[0][1]).toEqual(['nfl']);
    expect(batch).toHaveLength(2);
    expect(batch[1][0]).toBe('INSERT OR REPLACE INTO things (id, sport, team, num) VALUES (?, ?, ?, ?), (?, ?, ?, ?);');
    expect(batch[1][1]).toEqual(['a', 'nfl', 'NE', 2, 'b', 'nfl', 'KC', 1]);
    expect(db.has({ sport: 'nfl' })).toBe(true);
  });

  it('caches a has() miss, and re-probes only once a write could have satisfied it', async () => {
    const { conn, calls, setReader } = makeConn();
    const db = createSqliteRowTable(schema, conn);
    const probes = (): number => calls.filter((column) => column.sql.startsWith('SELECT 1 AS one')).length;
    setReader(() => []);

    expect(db.has({ sport: 'nfl' })).toBe(false);
    expect(db.has({ sport: 'nfl' })).toBe(false);
    expect(db.has({ sport: 'nfl' })).toBe(false);
    expect(probes()).toBe(1);

    await db.upsert([row('a', 'nfl', 'NE', 1)]);
    setReader(() => [{ one: 1 }]);
    expect(db.has({ sport: 'nfl' })).toBe(true);
    expect(probes()).toBe(2);

    expect(db.has({ sport: 'nfl' })).toBe(true);
    expect(probes()).toBe(2);
  });

  it('keeps a cached hit across an upsert, since an insert cannot empty a scope', async () => {
    const { conn, calls, setReader } = makeConn();
    const db = createSqliteRowTable(schema, conn);
    setReader(() => [{ one: 1 }]);
    expect(db.has({ sport: 'nfl' })).toBe(true);
    await db.upsert([row('b', 'nfl', 'KC', 2)]);
    expect(db.has({ sport: 'nfl' })).toBe(true);
    expect(calls.filter((column) => column.sql.startsWith('SELECT 1 AS one'))).toHaveLength(1);
  });

  it('drops a cached hit for a narrower scope when overwrite deleted the rows behind it', () => {
    const { conn, setReader } = makeConn();
    const db = createSqliteRowTable(schema, conn);
    setReader(() => [{ one: 1 }]);
    expect(db.has({ sport: 'nfl', team: 'NE' })).toBe(true);

    setReader(() => []);
    db.overwrite({ sport: 'nfl' }, []);

    expect(db.has({ sport: 'nfl', team: 'NE' })).toBe(false);
    expect(db.has({ sport: 'nfl' })).toBe(true);
  });

  it('getOne / find / findIn generate the expected SQL and map _array rows', () => {
    const { conn, calls, setReader } = makeConn();
    const db = createSqliteRowTable(schema, conn);

    setReader(() => [row('b', 'nfl', 'NE', 1)]);
    expect(db.getOne({ sport: 'nfl', id: 'b' })).toEqual(row('b', 'nfl', 'NE', 1));
    expect(last(calls)?.sql).toBe('SELECT * FROM things WHERE sport = ? AND id = ? LIMIT 1;');
    expect(last(calls)?.params).toEqual(['nfl', 'b']);

    setReader(() => [row('a', 'nfl', 'NE', 3), row('b', 'nfl', 'NE', 1)]);
    expect(db.find({ sport: 'nfl', team: 'NE' }, { orderBy: 'num' }).map((row) => row.id)).toEqual(['b', 'a']);
    expect(last(calls)?.sql).toBe('SELECT * FROM things WHERE sport = ? AND team = ?;');

    setReader(() => [row('a', 'nfl', 'NE', 1)]);
    db.findIn({ sport: 'nfl' }, 'id', ['a', 'c']);
    expect(last(calls)?.sql).toBe('SELECT * FROM things WHERE sport = ? AND id IN (?, ?);');
    expect(last(calls)?.params).toEqual(['nfl', 'a', 'c']);
  });

  it('findIn chunks large IN lists under the bind limit', () => {
    const { conn, calls, setReader } = makeConn();
    const db = createSqliteRowTable(schema, conn);
    setReader(() => []);
    const ids = Array.from({ length: 5 }, (_, index) => `id${index}`);
    db.findIn({}, 'id', ids, { chunk: 2 });
    const selects = calls.filter((column) => column.sql.startsWith('SELECT * FROM things WHERE id IN'));
    expect(selects).toHaveLength(3);
  });

  it('getMeta / setMeta target the meta table', () => {
    const { conn, calls, setReader } = makeConn();
    const db = createSqliteRowTable(schema, conn);
    db.setMeta({ sport: 'nfl' }, 'etag-9');
    expect(last(calls)?.sql).toBe('INSERT OR REPLACE INTO things_meta (sport, etag) VALUES (?, ?);');
    expect(last(calls)?.params).toEqual(['nfl', 'etag-9']);

    setReader((sql) => (sql.startsWith('SELECT sport, etag') ? [{ sport: 'nfl', etag: 'etag-9' }] : []));
    expect(db.getMeta({ sport: 'nfl' })).toBe('etag-9');
  });

  it('deletes the meta row on undefined, rather than writing an empty string a fetch would still send', () => {
    const { conn, calls } = makeConn();
    const db = createSqliteRowTable(schema, conn);
    db.setMeta({ sport: 'nfl' }, 'etag-9');

    db.setMeta({ sport: 'nfl' }, undefined);

    expect(last(calls)?.sql).toBe('DELETE FROM things_meta WHERE sport = ?;');
    expect(last(calls)?.params).toEqual(['nfl']);
    expect(db.getMeta({ sport: 'nfl' })).toBeUndefined();
  });

  it('writes nothing for a clear with no etag to clear, which is every socket flush after the first', () => {
    const { conn, calls } = makeConn();
    const db = createSqliteRowTable(schema, conn);
    db.setMeta({ sport: 'nfl' }, 'etag-9');
    db.setMeta({ sport: 'nfl' }, undefined);
    const callsAfterFirstClear = calls.length;

    db.setMeta({ sport: 'nfl' }, undefined);
    db.setMeta({ sport: 'nba' }, undefined);

    expect(calls.length).toBe(callsAfterFirstClear);
  });

  it('clears an etag it has only ever seen on disk, not one it wrote this session', () => {
    const { conn, calls, setReader } = makeConn();
    const db = createSqliteRowTable(schema, conn);
    setReader((sql) => (sql.startsWith('SELECT sport, etag') ? [{ sport: 'nfl', etag: 'etag-cold' }] : []));

    db.setMeta({ sport: 'nfl' }, undefined);

    expect(last(calls)?.sql).toBe('DELETE FROM things_meta WHERE sport = ?;');
    expect(db.getMeta({ sport: 'nfl' })).toBeUndefined();
  });

  it('getMeta bulk-loads the whole meta table once, then serves every scope from cache', () => {
    const { conn, calls, setReader } = makeConn();
    const db = createSqliteRowTable(schema, conn);
    setReader((sql) => (sql.startsWith('SELECT sport, etag') ? [{ sport: 'nfl', etag: 'etag-cold' }] : []));
    expect(db.getMeta({ sport: 'nfl' })).toBe('etag-cold');
    expect(last(calls)?.sql).toBe('SELECT sport, etag FROM things_meta;');
    const callsAfterLoad = calls.length;
    expect(db.getMeta({ sport: 'nba' })).toBeUndefined();
    expect(db.getMeta({ sport: 'nfl' })).toBe('etag-cold');
    expect(calls.length).toBe(callsAfterLoad);
  });

  const shredSpec = {
    version: 1 as const,
    table: 'things',
    insertVerb: 'INSERT OR REPLACE' as const,
    columns: ['id', 'sport'],
    ops: [
      { op: 'text' as const, path: 'id' },
      { op: 'bind' as const, index: 0 },
    ],
    deleteWhere: [{ column: 'sport', bindIndex: 0 }],
  };

  it('shred prefers the native shred spec when the connection supports it (no JS object graph)', async () => {
    const { conn } = makeConn();
    const shredJsonArrayAsync = jest.fn(async () => 2);
    const db = createSqliteRowTable(
      schema,
      { ...conn, shredJsonArrayAsync },
      { specs: { all: shredSpec }, variant: () => 'all', binds: (scope) => [String(scope.sport)] },
    );
    const parseRows = jest.fn(() => [] as TestRow[]);
    const count = await db.shred({ sport: 'nfl' }, '[{"id":"p1"}]', parseRows);
    expect(shredJsonArrayAsync).toHaveBeenCalledWith(shredSpec, '[{"id":"p1"}]', ['nfl']);
    expect(parseRows).not.toHaveBeenCalled();
    expect(count).toBe(2);
  });

  describe('secondary indexes are deferred across a shred into an empty table', () => {
    const makeShredStore = (conn: SqliteConnection, shredJsonArrayAsync: (...args: never[]) => Promise<number> = async () => 2) =>
      createSqliteRowTable(
        schema,
        { ...conn, shredJsonArrayAsync: shredJsonArrayAsync as SqliteConnection['shredJsonArrayAsync'] },
        { specs: { all: shredSpec }, variant: () => 'all', binds: (scope) => [String(scope.sport)] },
      );

    const ddl = (calls: Array<{ sql: string }>) => calls.map((column) => column.sql).filter((schema) => /DROP INDEX|CREATE INDEX/.test(schema));
    const drain = () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      });

    /** A shred that parks until its gate is called, so overlapping ingests finish in a chosen order. */
    const gatedShred = () => {
      const gates: Array<() => void> = [];
      return {
        gates,
        shred: () =>
          new Promise<number>((resolve) => {
            gates.push(() => resolve(2));
          }),
      };
    };

    it('drops them before the shred and rebuilds them after', async () => {
      const { conn, calls, setReader } = makeConn();
      setReader(() => []); // the emptiness probe finds no rows
      await makeShredStore(conn).shred({ sport: 'nfl' }, '[{"id":"p1"}]', () => []);

      expect(ddl(calls)).toEqual(['DROP INDEX IF EXISTS idx_things_team;', 'CREATE INDEX IF NOT EXISTS idx_things_team ON things (sport, team);']);
    });

    it('leaves them alone when the table already holds rows, whose reads would lose the index', async () => {
      const { conn, calls, setReader } = makeConn();
      setReader(() => [{ 1: 1 }]); // the emptiness probe finds a row
      await makeShredStore(conn).shred({ sport: 'nfl' }, '[{"id":"p1"}]', () => []);

      expect(ddl(calls)).toEqual([]);
    });

    it('rebuilds them even when the shred throws, so a failure cannot leave the table silently unindexed', async () => {
      const { conn, calls, setReader } = makeConn();
      setReader(() => []);
      const table = makeShredStore(conn, async () => {
        throw new Error('shred exploded');
      });

      await table.shred({ sport: 'nfl' }, '[]', () => [row('a', 'nfl', 'NE', 1)]);

      expect(last(ddl(calls))).toBe('CREATE INDEX IF NOT EXISTS idx_things_team ON things (sport, team);');
    });

    it('probes emptiness once per ingest rather than per row', async () => {
      const { conn, calls, setReader } = makeConn();
      setReader(() => []);
      await makeShredStore(conn).shred({ sport: 'nfl' }, '[{"id":"p1"}]', () => []);

      expect(calls.filter((column) => column.sql.includes('SELECT 1 FROM things LIMIT 1'))).toHaveLength(1);
    });

    it('drops once and rebuilds once across overlapping ingests, not once each', async () => {
      const { conn, calls, setReader } = makeConn();
      setReader(() => []);
      const { gates, shred } = gatedShred();
      const table = makeShredStore(conn, shred);

      const ingests = [table.shred({ sport: 'nfl' }, '[{"id":"p1"}]', () => []), table.shred({ sport: 'nba' }, '[{"id":"p2"}]', () => [])];
      await drain();
      gates.forEach((open) => open());
      await Promise.all(ingests);

      expect(ddl(calls)).toEqual(['DROP INDEX IF EXISTS idx_things_team;', 'CREATE INDEX IF NOT EXISTS idx_things_team ON things (sport, team);']);
      expect(calls.filter((column) => column.sql.includes('SELECT 1 FROM things LIMIT 1'))).toHaveLength(1);
    });

    it('rebuilds only after the last overlapping ingest finishes, so the tail is not indexed row by row', async () => {
      const { conn, calls, setReader } = makeConn();
      setReader(() => []);
      const { gates, shred } = gatedShred();
      const table = makeShredStore(conn, shred);

      const ingests = [table.shred({ sport: 'nfl' }, '[{"id":"p1"}]', () => []), table.shred({ sport: 'nba' }, '[{"id":"p2"}]', () => [])];
      await drain();
      expect(gates).toHaveLength(2);

      gates[0]();
      await drain();
      expect(ddl(calls)).toEqual(['DROP INDEX IF EXISTS idx_things_team;']);

      gates[1]();
      await Promise.all(ingests);

      expect(last(ddl(calls))).toBe('CREATE INDEX IF NOT EXISTS idx_things_team ON things (sport, team);');
    });
  });

  it('shred falls back to parseRows when the native shred spec throws', async () => {
    const { conn, batches } = makeConn();
    const shredJsonArrayAsync = jest.fn(async () => {
      throw new Error('unsupported op on this build');
    });
    const db = createSqliteRowTable(schema, { ...conn, shredJsonArrayAsync }, { specs: { all: shredSpec }, variant: () => 'all', binds: () => ['nfl'] });
    const count = await db.shred({ sport: 'nfl' }, '[]', () => [row('a', 'nfl', 'NE', 1)]);
    expect(count).toBe(1);
    expect(batches[0][0][0]).toBe('DELETE FROM things WHERE sport = ?;');
    expect(batches[0][1][0]).toContain('INSERT OR REPLACE INTO things');
  });

  it('shred falls back to parseRows when the scope names a variant the spec table has no entry for', async () => {
    const { conn } = makeConn();
    const shredJsonArrayAsync = jest.fn(async () => 2);
    const db = createSqliteRowTable(
      schema,
      { ...conn, shredJsonArrayAsync },
      { specs: { all: shredSpec }, variant: () => 'nonexistent', binds: () => ['nfl'] },
    );

    const count = await db.shred({ sport: 'nfl' }, '[]', () => [row('a', 'nfl', 'NE', 1)]);

    expect(shredJsonArrayAsync).not.toHaveBeenCalled();
    expect(count).toBe(1);
  });

  it('shred reports the shred fallback, since callers cannot observe it', async () => {
    resetOnceGuards();
    const captureException = jest.fn();
    configureDataKernel({ errors: { captureException, captureMessage: jest.fn() } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { conn } = makeConn();
    const shredJsonArrayAsync = jest.fn(async () => {
      throw new Error('unsupported op on this build');
    });
    const db = createSqliteRowTable(schema, { ...conn, shredJsonArrayAsync }, { specs: { all: shredSpec }, variant: () => 'all', binds: () => ['nfl'] });
    await db.shred({ sport: 'nfl' }, '[]', () => [row('a', 'nfl', 'NE', 1)]);

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][1].tags).toEqual({ off_heap_degradation: 'row_table.native_shred.things' });

    configureDataKernel({ errors: INERT_ERRORS });
    warn.mockRestore();
  });

  it('shred shreds via parseRows + insert when there is no native shred spec', async () => {
    const { conn, batches } = makeConn();
    const db = createSqliteRowTable(schema, conn);
    const count = await db.shred({ sport: 'nfl' }, 'raw', () => [row('a', 'nfl', 'NE', 1)]);
    expect(count).toBe(1);
    expect(batches[0][0][0]).toBe('DELETE FROM things WHERE sport = ?;');
    expect(batches[0][1][0]).toContain('INSERT OR REPLACE INTO things');
  });
});

describe('row_table — inserts are grouped into multi-row statements', () => {
  beforeAll(async () => {
    await initSqlJs();
  });

  /** `schema` has 4 columns, against SQLite's 999-bind ceiling. */
  const ROWS_PER_INSERT = 249;
  const seed = (count: number) => Array.from({ length: count }, (_, index) => row(`p${index}`, 'nfl', 'NE', index));

  it('groups rows up to the bind ceiling rather than emitting a statement each', async () => {
    const { conn, batches } = makeConn();
    // One chunk holding every row, so the split under test is the bind ceiling rather than the chunk size.
    await createSqliteRowTable(schema, conn).upsert(seed(600), { chunk: 600 });

    const inserts = batches[0];
    expect(inserts).toHaveLength(3); // 249 + 249 + 102
    expect(inserts[0][1]).toHaveLength(ROWS_PER_INSERT * 4);
    expect(inserts[2][1]).toHaveLength((600 - 2 * ROWS_PER_INSERT) * 4);
    for (const [, params] of inserts) expect(params.length).toBeLessThanOrEqual(999);
  });

  it('opens one transaction per chunk, so a long flush yields the thread between them', async () => {
    const { conn, batches } = makeConn();
    await createSqliteRowTable(schema, conn).upsert(seed(600), { chunk: 250 });

    // Three chunks of 250, 250, 100, each still split at the bind ceiling inside its own transaction.
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
  });

  it('lands every row through real SQLite', async () => {
    const conn = createSqlJsConnection({ capabilities: 'full' });
    const db = createSqliteRowTable(schema, conn);
    db.init();
    await db.upsert(seed(600));

    const found = db.find({ sport: 'nfl' }, { orderBy: 'num' });
    expect(found).toHaveLength(600);
    expect(found.map((row) => row.id).slice(0, 3)).toEqual(['p0', 'p1', 'p2']);
    expect(last(found)?.id).toBe('p599');
    conn.close();
  });

  it('still settles a collision inside one statement in favour of the later row', async () => {
    const conn = createSqlJsConnection({ capabilities: 'full' });
    const db = createSqliteRowTable(schema, conn);
    db.init();
    await db.upsert([row('a', 'nfl', 'NE', 1), row('a', 'nfl', 'KC', 2)]);

    expect(db.find({ sport: 'nfl' })).toEqual([row('a', 'nfl', 'KC', 2)]);
    conn.close();
  });
});

describe('row_table — memory and SQLite answer the same `where`', () => {
  beforeAll(async () => {
    await initSqlJs();
  });

  const seed: TestRow[] = [row('a', 'nfl', 'NE', 2), row('b', 'nfl', null, 1), row('c', 'nfl', 'KC', null)];

  const bothBackends = (where: Partial<TestRow>): { memory: string[]; sqlite: string[] } => {
    const memory = createMemoryRowTable(schema);
    memory.overwrite({ sport: 'nfl' }, seed);

    const sqlite = createSqliteRowTable(schema, createSqlJsConnection({ capabilities: 'full' }));
    sqlite.init();
    sqlite.overwrite({ sport: 'nfl' }, seed);

    const ids = (rows: TestRow[]): string[] => rows.map((row) => row.id).sort();
    return { memory: ids(memory.find(where)), sqlite: ids(sqlite.find(where)) };
  };

  it('agrees on a plain equality', () => {
    const { memory, sqlite } = bothBackends({ sport: 'nfl', team: 'NE' });
    expect(memory).toEqual(['a']);
    expect(sqlite).toEqual(memory);
  });

  it('agrees that a null constraint means the rows holding null, not none of them', () => {
    const { memory, sqlite } = bothBackends({ sport: 'nfl', team: null });
    expect(memory).toEqual(['b']);
    expect(sqlite).toEqual(memory);
  });

  it('reads `undefined` as the same constraint as `null`, because SQLite cannot return the difference', () => {
    const { memory, sqlite } = bothBackends({ sport: 'nfl', team: undefined });
    expect(memory).toEqual(['b']);
    expect(sqlite).toEqual(memory);
  });

  it('agrees on a null over a numeric column too, so this is not a TEXT-only accident', () => {
    const { memory, sqlite } = bothBackends({ sport: 'nfl', num: null });
    expect(memory).toEqual(['c']);
    expect(sqlite).toEqual(memory);
  });

  it('never widens to the whole table, which is what dropping the constraint would do to a scoped DELETE', () => {
    const { memory, sqlite } = bothBackends({ sport: 'nba', team: undefined });
    expect(memory).toEqual([]);
    expect(sqlite).toEqual([]);
  });
});

describe('row_table — the shred spec must delete what the scope names', () => {
  const shredSpec = (deleteWhere: Array<{ column: string; bindIndex: number }>): NativeShredSpec => ({
    specs: {
      all: {
        version: 1,
        table: 'things',
        insertVerb: 'INSERT OR REPLACE',
        // Must be the schema's NOT NULL columns: an insert that violates the constraint degrades to the JS path too.
        columns: ['id', 'sport'],
        ops: [
          { op: 'text', path: 'id' },
          { op: 'bind', index: 0 },
        ],
        deleteWhere,
      },
    },
    variant: () => 'all',
    binds: (scope) => [String(scope.sport ?? '')],
  });

  const shredding = (deleteWhere: Array<{ column: string; bindIndex: number }>) => {
    const conn = createSqlJsConnection({ capabilities: 'full' });
    const db = createSqliteRowTable(schema, conn, shredSpec(deleteWhere));
    db.init();
    return db;
  };

  beforeAll(async () => {
    await initSqlJs();
  });

  it('shreds when the spec deletes exactly the scope', async () => {
    const db = shredding([{ column: 'sport', bindIndex: 0 }]);

    await expect(db.shred({ sport: 'nfl' }, '[{"id":"a"}]', () => [])).resolves.toBe(1);
  });

  itDev('rejects a spec that deletes less than the scope, which turns replace into append', async () => {
    const db = shredding([]);

    await expect(db.shred({ sport: 'nfl' }, '[{"id":"a"}]', () => [])).rejects.toThrow(/does not cover `sport`/);
  });

  itDev('rejects a spec that deletes more than the scope, which reaches outside the partition', async () => {
    const db = shredding([
      { column: 'sport', bindIndex: 0 },
      { column: 'team', bindIndex: 0 },
    ]);

    await expect(db.shred({ sport: 'nfl' }, '[{"id":"a"}]', () => [])).rejects.toThrow(/covers `team`/);
  });

  itProd('degrades to the JS path rather than failing ingest, since by release the spec has been exercised', async () => {
    const db = shredding([]);
    const parsed = [row('a', 'nfl', null, null)];

    await expect(db.shred({ sport: 'nfl' }, '[{"id":"a"}]', () => parsed)).resolves.toBe(1);
  });
});

describe('row_table — a write must land inside the filter it replaced', () => {
  itDev('rejects a row whose columns fall outside the filter, which would strand it where no later write reaches', () => {
    const db = createMemoryRowTable(schema);
    db.init();

    expect(() => db.overwrite({ sport: 'nfl' }, [row('a', 'nba', 'BOS', 1)])).toThrow(/`sport` is "nba", not "nfl"/);
  });

  itDev('rejects the same row arriving through the JS half of an ingest', async () => {
    const db = createMemoryRowTable(schema);
    db.init();

    await expect(db.shred({ sport: 'nfl' }, '[]', () => [row('a', 'nba', 'BOS', 1)])).rejects.toThrow(/does not match the filter it replaced/);
  });

  it('allows a row that matches on every column the filter names, whatever else it carries', () => {
    const db = createMemoryRowTable(schema);
    db.init();

    expect(db.overwrite({ sport: 'nfl' }, [row('a', 'nfl', 'SF', 1), row('b', 'nfl', 'KC', 2)])).toBe(2);
  });
});

describe('row_table — a schema change, run against real SQLite', () => {
  beforeAll(async () => {
    await initSqlJs();
  });

  const v2: RowTableSchema<TestRow & { position: string | null }> = {
    ...schema,
    columns: { ...schema.columns, position: { type: 'TEXT' } },
  };

  const upgrade = (next: RowTableSchema<any>) => {
    const conn = createSqlJsConnection({ capabilities: 'full' });
    const before = createSqliteRowTable(schema, conn);
    before.init();
    before.overwrite({ sport: 'nfl' }, [row('a', 'nfl', 'NE', 1), row('b', 'nfl', 'KC', 2)]);
    before.setMeta({ sport: 'nfl' }, 'etag-v1');

    const after = createSqliteRowTable(next, conn);
    after.init();
    return { conn, after };
  };

  it('carries the new column, so a read of it is not a SQL error', () => {
    const { after } = upgrade(v2);

    after.overwrite({ sport: 'nfl' }, [{ id: 'c', sport: 'nfl', team: 'SF', num: 3, position: 'QB' }]);

    expect(after.getOne({ sport: 'nfl', id: 'c' })?.position).toBe('QB');
  });

  it('keeps the rows the old schema wrote, since a column added beside them restates none of them', () => {
    const { after } = upgrade(v2);

    expect(
      after
        .find({ sport: 'nfl' })
        .map((row) => row.id)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('reads the added column as null on those rows, which is what no value yet has to look like', () => {
    const { after } = upgrade(v2);

    expect(after.getOne({ sport: 'nfl', id: 'a' })?.position ?? null).toBeNull();
  });

  it('drops the etag, or the fetch that fills the added column answers 304 and it stays null', () => {
    const { after } = upgrade(v2);

    expect(after.getMeta({ sport: 'nfl' })).toBeUndefined();
  });

  it('leaves the widened table current, so the next launch plans nothing at all', () => {
    const { conn } = upgrade(v2);

    const again = createSqliteRowTable(v2, conn);
    again.init();

    expect(
      again
        .find({ sport: 'nfl' })
        .map((row) => row.id)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('rebuilds instead where the added column is NOT NULL, which ALTER TABLE cannot add to rows that exist', () => {
    const notNull: RowTableSchema<TestRow & { position: string | null }> = {
      ...schema,
      columns: { ...schema.columns, position: { type: 'TEXT', notNull: true } },
    };
    const { after } = upgrade(notNull);

    expect(after.find({ sport: 'nfl' })).toEqual([]);
  });

  it('leaves an unchanged schema alone — the same build reopening its own database keeps its rows and its etag', () => {
    const { after } = upgrade(schema);

    expect(
      after
        .find({ sport: 'nfl' })
        .map((row) => row.id)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(after.getMeta({ sport: 'nfl' })).toBe('etag-v1');
  });

  it('applies an index change, which no column comparison could have detected', () => {
    const reindexed: RowTableSchema<TestRow> = { ...schema, indexes: [{ name: 'idx_things_team', columns: ['sport', 'num'] }] };
    const { conn, after } = upgrade(reindexed);

    const indexed = readRows<{ name: string }>(conn, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'things';");
    const columns = readRows<{ name: string }>(conn, 'PRAGMA index_info(idx_things_team);');

    expect(indexed.map((row) => row.name)).toContain('idx_things_team');
    expect(columns).toHaveLength(2);
    expect(after.find({ sport: 'nfl' })).toEqual([]);
  });
});
