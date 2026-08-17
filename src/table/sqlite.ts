/** The row table on SQLite: rows live in the database, and become JS objects at the moment a read materializes them. */

import { cacheKey } from '../args_key';
import { chunkList } from '../collections';
import { createPresence, whereMapKey } from './presence';
import { columnNames, FindOpts, IndexDef, RowShape, RowTable, RowTableSchema, SqlValue } from './types';
import { assertRowsMatchWhere, comparator, whereClause } from './query';
import {
  addColumnSql,
  addedColumns,
  createIndexSql,
  createMetaTableSql,
  createTableSql,
  dropIndexSql,
  planSchemaMigration,
  readLiveSchema,
  reportPushFedRebuild,
  schemaFingerprint,
  schemaStructureStamp,
} from './schema';
import { NativeShredSpec } from '../write/shred_spec';
import { BatchCommand, readRows, runBatch, runBatchAsync, SqliteConnection } from './connection';
import { reportStoreDegradation } from '../diagnostics/telemetry';

const MAX_BIND_VARIABLES = 999; // SQLite's pre-3.32 default
const DEFAULT_IN_CHUNK = 900;
const DEFAULT_UPSERT_CHUNK = 250; // rows per transaction, sized to stay sub-frame

function bindList(count: number): string {
  return new Array(count).fill('?').join(', ');
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** A shred spec whose wiring is wrong: a bug, and the one shred failure that propagates past the fallback. */
class ShredSpecMisconfigured extends Error {}

/** Dev-only: `deleteWhere` must name exactly the filter's columns, so the native and JS paths replace the same rows. */
function assertDeleteWhereMatches(table: string, variant: string, spec: { deleteWhere: ReadonlyArray<{ column: string }> }, where: Partial<RowShape>): void {
  const deleteColumns = new Set(spec.deleteWhere.map((clause) => clause.column));
  const whereColumns = Object.keys(where);
  const missing = whereColumns.filter((column) => !deleteColumns.has(column));
  const extra = [...deleteColumns].filter((column) => !whereColumns.includes(column));
  if (!missing.length && !extra.length) return;

  const detail = [
    missing.length
      ? `does not cover ${missing
          .map((column) => `\`${column}\``)
          .join(', ')} — the replace would leave the previous rows behind and the insert would append to them`
      : '',
    extra.length
      ? `covers ${extra.map((column) => `\`${column}\``).join(', ')}, which the filter does not — the replace would reach outside the partition being written`
      : '',
  ]
    .filter(Boolean)
    .join('; and it ');

  throw new ShredSpecMisconfigured(
    `row_table: the '${variant}' shred spec for \`${table}\` ${detail}. ` +
      `\`deleteWhere\` must name exactly the columns of the filter passed to \`shred\` (${
        whereColumns.map((column) => `\`${column}\``).join(', ') || 'none'
      }), ` +
      `so the native and JS ingest paths replace the same rows.`,
  );
}

/**
 * The {@link RowTable} over a real database, and the point of the whole layer: the rows stay in SQLite, and only the
 * ones a read selects are ever built as JS objects. `defineSqliteStore` constructs one once a connection is bound, and
 * its `init` has to run before any other call, since that is what creates the table or rebuilds a stale one.
 */
export function createSqliteRowTable<Row extends RowShape>(
  schema: RowTableSchema<Row>,
  conn: SqliteConnection,
  nativeShredSpec?: NativeShredSpec,
): RowTable<Row> {
  const cols = columnNames(schema);
  const hasPk = schema.primaryKey.length > 0;
  const colList = cols.join(', ');
  const placeholders = bindList(cols.length);
  const insertVerb = hasPk ? 'INSERT OR REPLACE' : 'INSERT';

  const rowsPerInsert = Math.max(1, Math.floor(MAX_BIND_VARIABLES / cols.length));
  const insertSql = (rowCount: number): string =>
    `${insertVerb} INTO ${schema.table} (${colList}) VALUES ${new Array(rowCount).fill(`(${placeholders})`).join(', ')};`;

  const presence = createPresence();

  // `setMeta` is the only writer, so once loaded this cache answers every etag read on its own.
  const metaCache = new Map<string, string | undefined>();
  let metaLoaded = false;
  const metaKey = (where: Partial<Row>): string =>
    schema.meta ? cacheKey(...schema.meta.keyColumns.map((column) => String(where[column as keyof Row] ?? ''))) : '';
  function ensureMetaLoaded(meta: NonNullable<typeof schema.meta>): void {
    if (metaLoaded) return;
    const cols = [...meta.keyColumns, meta.column];
    const rows = readRows<Record<string, string | undefined>>(conn, `SELECT ${cols.join(', ')} FROM ${meta.table};`);
    for (const row of rows) metaCache.set(metaKey(row as Partial<Row>), row[meta.column] ?? undefined);
    metaLoaded = true;
  }

  const secondaryIndexes = schema.indexes ?? [];
  const runIndexDdl = async (sql: (idx: IndexDef<Row>) => string): Promise<void> => {
    for (const idx of secondaryIndexes) {
      // eslint-disable-next-line no-await-in-loop -- DDL must not interleave
      if (conn.executeAsync) await conn.executeAsync(sql(idx));
      else conn.execute(sql(idx));
    }
  };

  let deferrals = 0;

  /** Bulk-writes with the secondary indexes dropped and rebuilt after: one sort beats maintaining them row by row. */
  async function withDeferredIndexes<T>(write: () => Promise<T>): Promise<T> {
    const defer = secondaryIndexes.length > 0 && (deferrals > 0 || readRows(conn, `SELECT 1 FROM ${schema.table} LIMIT 1;`).length === 0);
    if (!defer) return write();
    deferrals += 1;
    // Swallowed: the rebuild below is `IF NOT EXISTS`, so it restores whatever did drop.
    if (deferrals === 1) await runIndexDdl(dropIndexSql).catch(() => {});
    try {
      return await write();
    } finally {
      deferrals -= 1;
      if (deferrals === 0) await runIndexDdl((idx) => createIndexSql(schema.table, idx));
    }
  }

  function deleteWhereCmd(where: Partial<Row>): BatchCommand {
    const { sql, params } = whereClause(where);
    return [`DELETE FROM ${schema.table}${sql};`, params];
  }

  async function shredOrParse(where: Partial<Row>, rawJson: string, parseRows: (rawJson: string) => Row[]): Promise<number> {
    if (conn.shredJsonArrayAsync && nativeShredSpec) {
      try {
        const variant = nativeShredSpec.variant(where as Record<string, SqlValue>);
        const spec = nativeShredSpec.specs[variant];
        // A partition with no spec entry is one this store shreds in JS; the catch below is that fallback.
        if (!spec) throw new Error(`row_table: shred variant '${variant}' is not in the spec table`);
        if (__DEV__) assertDeleteWhereMatches(schema.table, variant, spec, where);
        const binds = nativeShredSpec.binds(where as Record<string, SqlValue>);
        const count = await conn.shredJsonArrayAsync(spec, rawJson, binds);
        presence.afterDelete(where);
        return count;
      } catch (error) {
        if (error instanceof ShredSpecMisconfigured) throw error;
        reportStoreDegradation({
          scope: `row_table.native_shred.${schema.table}`,
          context: 'native shred failed; fell back to the JS parse path, which builds the transient object graph the shred exists to avoid',
          error,
          extra: { table: schema.table, where: whereMapKey(where), rawLength: rawJson.length },
        });
      }
    }
    const rows = parseRows(rawJson);
    if (__DEV__) assertRowsMatchWhere(schema.table, where, rows);
    await runBatchAsync(conn, [deleteWhereCmd(where), ...insertCmds(rows)]);
    presence.afterDelete(where);
    return rows.length;
  }

  function insertCmds(rows: readonly Row[]): BatchCommand[] {
    return chunkList(rows, rowsPerInsert).map((group) => {
      const params: SqlValue[] = [];
      for (const row of group) {
        for (const col of cols) params.push(row[col] ?? null);
      }
      return [insertSql(group.length), params];
    });
  }

  function selectRows(where: Partial<Row>): Row[] {
    const { sql, params } = whereClause(where);
    return readRows<Row>(conn, `SELECT * FROM ${schema.table}${sql};`, params);
  }

  return {
    init(): void {
      const live = readLiveSchema(conn, schema.table);
      const plan = planSchemaMigration(schema, live, nativeShredSpec);
      if (plan === 'rebuild') {
        if (schema.pushFed) reportPushFedRebuild(schema.table);
        // Drops the table's indexes with it, which is how an index change gets applied.
        conn.execute(`DROP TABLE IF EXISTS ${schema.table};`);
        // The etags describe the dropped rows, so keeping them would 304 the refetch away.
        if (schema.meta) conn.execute(`DROP TABLE IF EXISTS ${schema.meta.table};`);
      }
      // A widening keeps every row, so this is the one migration that costs a user nothing.
      if (plan === 'extend') for (const column of addedColumns(schema, live.columns) ?? []) conn.execute(addColumnSql(schema, column));
      conn.execute(createTableSql(schema));
      for (const idx of secondaryIndexes) conn.execute(createIndexSql(schema.table, idx));
      if (schema.meta) conn.execute(createMetaTableSql(schema.meta));
      // The columns a widening just added are NULL in every row that predates them, and a kept etag would answer the
      // fetch that fills them with a 304. Dropped rather than dropping the table, so the rows stay.
      if (plan === 'extend' && schema.meta) conn.execute(`DELETE FROM ${schema.meta.table};`);
      // Stamped even where the plan is `none`, so a database built before this stamp existed acquires one on the next
      // launch, and its next widening is an `ALTER TABLE` rather than a rebuild. `PRAGMA` takes no bind parameter.
      const structure = schemaStructureStamp(schema, nativeShredSpec);
      if (live.structure !== structure) conn.execute(`PRAGMA application_id = ${structure};`);
      // Stamped last, so a stamp only ever describes a fully built schema.
      if (plan !== 'none') conn.execute(`PRAGMA user_version = ${schemaFingerprint(schema, nativeShredSpec)};`);
    },

    async upsert(rows: readonly Row[], opts?: { chunk?: number }): Promise<number> {
      if (!rows.length) return 0;
      const size = opts?.chunk ?? DEFAULT_UPSERT_CHUNK;
      const chunks = chunkList(rows, size);
      for (let index = 0; index < chunks.length; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential by design: one transaction per chunk
        await runBatchAsync(conn, insertCmds(chunks[index]));
        // eslint-disable-next-line no-await-in-loop -- release the JS thread between chunks
        if (index < chunks.length - 1) await yieldToEventLoop();
      }
      presence.afterInsert();
      return rows.length;
    },

    overwrite(where: Partial<Row>, rows: readonly Row[]): number {
      if (__DEV__) assertRowsMatchWhere(schema.table, where, rows);
      runBatch(conn, [deleteWhereCmd(where), ...insertCmds(rows)]);
      presence.afterDelete(where);
      return rows.length;
    },

    async shred(where: Partial<Row>, rawJson: string, parseRows: (rawJson: string) => Row[]): Promise<number> {
      return withDeferredIndexes(() => shredOrParse(where, rawJson, parseRows));
    },

    getOne(where: Partial<Row>): Row | undefined {
      const { sql, params } = whereClause(where);
      return readRows<Row>(conn, `SELECT * FROM ${schema.table}${sql} LIMIT 1;`, params)[0];
    },

    find(where: Partial<Row>, opts?: FindOpts<Row>): Row[] {
      const out = selectRows(where);
      if (opts?.orderBy) out.sort(comparator<Row>(opts.orderBy));
      return out;
    },

    findIn(where: Partial<Row>, column: keyof Row & string, values: readonly string[], opts?: { chunk?: number }): Row[] {
      if (!values.length) return [];
      const rowFilter = whereClause(where);
      const prefix = rowFilter.sql ? `${rowFilter.sql} AND ` : ' WHERE ';
      const out: Row[] = [];
      for (const chunk of chunkList(values, opts?.chunk ?? DEFAULT_IN_CHUNK)) {
        const placeholders = bindList(chunk.length);
        const rows = readRows<Row>(conn, `SELECT * FROM ${schema.table}${prefix}${column} IN (${placeholders});`, [...rowFilter.params, ...chunk]);
        for (const row of rows) out.push(row);
      }
      return out;
    },

    has(where: Partial<Row>): boolean {
      const cached = presence.get(where);
      if (cached !== undefined) return cached;
      const { sql, params } = whereClause(where);
      const row = readRows<{ one?: number }>(conn, `SELECT 1 AS one FROM ${schema.table}${sql} LIMIT 1;`, params)[0];
      presence.observe(where, !!row);
      return !!row;
    },

    getMeta(where: Partial<Row>): string | undefined {
      const meta = schema.meta;
      if (!meta) return undefined;
      ensureMetaLoaded(meta);
      return metaCache.get(metaKey(where));
    },

    setMeta(where: Partial<Row>, value: string | undefined): void {
      const meta = schema.meta;
      if (!meta) return;
      if (value === undefined) {
        ensureMetaLoaded(meta);
        if (metaCache.get(metaKey(where)) === undefined) return;
      }
      const keyCols = meta.keyColumns;
      const keyParams: SqlValue[] = keyCols.map((column) => where[column as keyof Row] as SqlValue);
      const allCols = [...keyCols, meta.column];
      const placeholders = bindList(allCols.length);
      const params: SqlValue[] = value === undefined ? keyParams : [...keyParams, value];
      // Fire-and-forget: a synchronous write would block the JS thread on SQLite's writer lock.
      metaCache.set(metaKey(where), value);
      const sql =
        value === undefined
          ? `DELETE FROM ${meta.table} WHERE ${keyCols.map((column) => `${column} = ?`).join(' AND ')};`
          : `INSERT OR REPLACE INTO ${meta.table} (${allCols.join(', ')}) VALUES (${placeholders});`;
      if (conn.executeAsync) {
        conn.executeAsync(sql, params).catch(() => {
          /* the in-session cache already holds the value */
        });
      } else {
        conn.execute(sql, params);
      }
    },
  };
}
