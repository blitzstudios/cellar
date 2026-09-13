"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createSqliteRowTable = createSqliteRowTable;
var _args_key = require("../args_key.js");
var _collections = require("../collections.js");
var _presence = require("./presence.js");
var _types = require("./types.js");
var _query = require("./query.js");
var _schema = require("./schema.js");
var _connection = require("./connection.js");
var _telemetry = require("../diagnostics/telemetry.js");
/** The row table on SQLite: rows live in the database, and become JS objects at the moment a read materializes them. */

const MAX_BIND_VARIABLES = 999; // SQLite's pre-3.32 default
const DEFAULT_IN_CHUNK = 900;
const DEFAULT_UPSERT_CHUNK = 250; // rows per transaction, sized to stay sub-frame

function bindList(count) {
  return new Array(count).fill('?').join(', ');
}
function yieldToEventLoop() {
  return new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}

/** A shred spec whose wiring is wrong: a bug, and the one shred failure that propagates past the fallback. */
class ShredSpecMisconfigured extends Error {}

/** Dev-only: `deleteWhere` must name exactly the filter's columns, so the native and JS paths replace the same rows. */
function assertDeleteWhereMatches(table, variant, spec, where) {
  const deleteColumns = new Set(spec.deleteWhere.map(clause => clause.column));
  const whereColumns = Object.keys(where);
  const missing = whereColumns.filter(column => !deleteColumns.has(column));
  const extra = [...deleteColumns].filter(column => !whereColumns.includes(column));
  if (!missing.length && !extra.length) return;
  const detail = [missing.length ? `does not cover ${missing.map(column => `\`${column}\``).join(', ')} — the replace would leave the previous rows behind and the insert would append to them` : '', extra.length ? `covers ${extra.map(column => `\`${column}\``).join(', ')}, which the filter does not — the replace would reach outside the partition being written` : ''].filter(Boolean).join('; and it ');
  throw new ShredSpecMisconfigured(`row_table: the '${variant}' shred spec for \`${table}\` ${detail}. ` + `\`deleteWhere\` must name exactly the columns of the filter passed to \`shred\` (${whereColumns.map(column => `\`${column}\``).join(', ') || 'none'}), ` + `so the native and JS ingest paths replace the same rows.`);
}

/**
 * The {@link RowTable} over a real database, and the point of the whole layer: the rows stay in SQLite, and only the
 * ones a read selects are ever built as JS objects. `defineSqliteStore` constructs one once a connection is bound, and
 * its `init` has to run before any other call, since that is what creates the table or rebuilds a stale one.
 */
function createSqliteRowTable(schema, conn, nativeShredSpec) {
  const cols = (0, _types.columnNames)(schema);
  const hasPk = schema.primaryKey.length > 0;
  const colList = cols.join(', ');
  const placeholders = bindList(cols.length);
  const insertVerb = hasPk ? 'INSERT OR REPLACE' : 'INSERT';
  const rowsPerInsert = Math.max(1, Math.floor(MAX_BIND_VARIABLES / cols.length));
  const insertSql = rowCount => `${insertVerb} INTO ${schema.table} (${colList}) VALUES ${new Array(rowCount).fill(`(${placeholders})`).join(', ')};`;
  const presence = (0, _presence.createPresence)();

  // `setMeta` is the only writer, so once loaded this cache answers every etag read on its own.
  const metaCache = new Map();
  let metaLoaded = false;
  const metaKey = where => schema.meta ? (0, _args_key.cacheKey)(...schema.meta.keyColumns.map(column => String(where[column] ?? ''))) : '';
  function ensureMetaLoaded(meta) {
    if (metaLoaded) return;
    const cols = [...meta.keyColumns, meta.column];
    const rows = (0, _connection.readRows)(conn, `SELECT ${cols.join(', ')} FROM ${meta.table};`);
    for (const row of rows) metaCache.set(metaKey(row), row[meta.column] ?? undefined);
    metaLoaded = true;
  }
  const secondaryIndexes = schema.indexes ?? [];
  const runIndexDdl = async sql => {
    for (const idx of secondaryIndexes) {
      // eslint-disable-next-line no-await-in-loop -- DDL must not interleave
      if (conn.executeAsync) await conn.executeAsync(sql(idx));else conn.execute(sql(idx));
    }
  };
  let deferrals = 0;

  /** Bulk-writes with the secondary indexes dropped and rebuilt after: one sort beats maintaining them row by row. */
  async function withDeferredIndexes(write) {
    // Never without a dedicated reader. Dropping and recreating indexes around the write turns one statement into
    // several, and every one of them is a window in which a read that needs a transaction — the ranker's `TEMP`
    // tables, which fall back to this handle when there is no reader — can land inside the write and be refused as a
    // nested transaction. That refusal degrades the store, which costs far more than the indexes save.
    const defer = !!conn.reader && secondaryIndexes.length > 0 && (deferrals > 0 || (0, _connection.readRows)(conn, `SELECT 1 FROM ${schema.table} LIMIT 1;`).length === 0);
    if (!defer) return write();
    deferrals += 1;
    // Swallowed: the rebuild below is `IF NOT EXISTS`, so it restores whatever did drop.
    if (deferrals === 1) await runIndexDdl(_schema.dropIndexSql).catch(() => {});
    try {
      return await write();
    } finally {
      deferrals -= 1;
      if (deferrals === 0) await runIndexDdl(idx => (0, _schema.createIndexSql)(schema.table, idx));
    }
  }
  function deleteWhereCmd(where) {
    const {
      sql,
      params
    } = (0, _query.whereClause)(where);
    return [`DELETE FROM ${schema.table}${sql};`, params];
  }
  async function shredOrParse(where, rawJson, parseRows) {
    if (conn.shredJsonArrayAsync && nativeShredSpec) {
      try {
        const variant = nativeShredSpec.variant(where);
        const spec = nativeShredSpec.specs[variant];
        // A partition with no spec entry is one this store shreds in JS; the catch below is that fallback.
        if (!spec) throw new Error(`row_table: shred variant '${variant}' is not in the spec table`);
        if (__DEV__) assertDeleteWhereMatches(schema.table, variant, spec, where);
        const binds = nativeShredSpec.binds(where);
        const count = await conn.shredJsonArrayAsync(spec, rawJson, binds);
        presence.afterDelete(where);
        return count;
      } catch (error) {
        if (error instanceof ShredSpecMisconfigured) throw error;
        (0, _telemetry.reportStoreDegradation)({
          scope: `row_table.native_shred.${schema.table}`,
          context: 'native shred failed; fell back to the JS parse path, which builds the transient object graph the shred exists to avoid',
          error,
          extra: {
            table: schema.table,
            where: (0, _presence.whereMapKey)(where),
            rawLength: rawJson.length
          }
        });
      }
    }
    const rows = parseRows(rawJson);
    if (__DEV__) (0, _query.assertRowsMatchWhere)(schema.table, where, rows);
    await (0, _connection.runBatchAsync)(conn, [deleteWhereCmd(where), ...insertCmds(rows)]);
    presence.afterDelete(where);
    return rows.length;
  }
  function insertCmds(rows) {
    return (0, _collections.chunkList)(rows, rowsPerInsert).map(group => {
      const params = [];
      for (const row of group) {
        for (const col of cols) params.push(row[col] ?? null);
      }
      return [insertSql(group.length), params];
    });
  }
  function selectRows(where) {
    const {
      sql,
      params
    } = (0, _query.whereClause)(where);
    return (0, _connection.readRows)(conn, `SELECT * FROM ${schema.table}${sql};`, params);
  }
  return {
    init() {
      const live = (0, _schema.readLiveSchema)(conn, schema.table);
      const plan = (0, _schema.planSchemaMigration)(schema, live, nativeShredSpec);
      if (plan === 'rebuild') {
        if (schema.pushFed) (0, _schema.reportPushFedRebuild)(schema.table);
        // Drops the table's indexes with it, which is how an index change gets applied.
        conn.execute(`DROP TABLE IF EXISTS ${schema.table};`);
        // The etags describe the dropped rows, so keeping them would 304 the refetch away.
        if (schema.meta) conn.execute(`DROP TABLE IF EXISTS ${schema.meta.table};`);
      }
      // A widening keeps every row, so this is the one migration that costs a user nothing.
      if (plan === 'extend') for (const column of (0, _schema.addedColumns)(schema, live.columns) ?? []) conn.execute((0, _schema.addColumnSql)(schema, column));
      conn.execute((0, _schema.createTableSql)(schema));
      for (const idx of secondaryIndexes) conn.execute((0, _schema.createIndexSql)(schema.table, idx));
      if (schema.meta) conn.execute((0, _schema.createMetaTableSql)(schema.meta));
      // The columns a widening just added are NULL in every row that predates them, and a kept etag would answer the
      // fetch that fills them with a 304. Dropped rather than dropping the table, so the rows stay.
      if (plan === 'extend' && schema.meta) conn.execute(`DELETE FROM ${schema.meta.table};`);
      // Stamped even where the plan is `none`, so a database built before this stamp existed acquires one on the next
      // launch, and its next widening is an `ALTER TABLE` rather than a rebuild. `PRAGMA` takes no bind parameter.
      const structure = (0, _schema.schemaStructureStamp)(schema, nativeShredSpec);
      if (live.structure !== structure) conn.execute(`PRAGMA application_id = ${structure};`);
      // Stamped last, so a stamp only ever describes a fully built schema.
      if (plan !== 'none') conn.execute(`PRAGMA user_version = ${(0, _schema.schemaFingerprint)(schema, nativeShredSpec)};`);
    },
    async upsert(rows, opts) {
      if (!rows.length) return 0;
      const size = opts?.chunk ?? DEFAULT_UPSERT_CHUNK;
      const chunks = (0, _collections.chunkList)(rows, size);
      for (let index = 0; index < chunks.length; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential by design: one transaction per chunk
        await (0, _connection.runBatchAsync)(conn, insertCmds(chunks[index]));
        // eslint-disable-next-line no-await-in-loop -- release the JS thread between chunks
        if (index < chunks.length - 1) await yieldToEventLoop();
      }
      presence.afterInsert();
      return rows.length;
    },
    overwrite(where, rows) {
      if (__DEV__) (0, _query.assertRowsMatchWhere)(schema.table, where, rows);
      (0, _connection.runBatch)(conn, [deleteWhereCmd(where), ...insertCmds(rows)]);
      presence.afterDelete(where);
      return rows.length;
    },
    async shred(where, rawJson, parseRows) {
      return withDeferredIndexes(() => shredOrParse(where, rawJson, parseRows));
    },
    getOne(where) {
      const {
        sql,
        params
      } = (0, _query.whereClause)(where);
      return (0, _connection.readRows)(conn, `SELECT * FROM ${schema.table}${sql} LIMIT 1;`, params)[0];
    },
    find(where, opts) {
      const out = selectRows(where);
      if (opts?.orderBy) out.sort((0, _query.comparator)(opts.orderBy));
      return out;
    },
    findIn(where, column, values, opts) {
      if (!values.length) return [];
      const rowFilter = (0, _query.whereClause)(where);
      const prefix = rowFilter.sql ? `${rowFilter.sql} AND ` : ' WHERE ';
      const out = [];
      for (const chunk of (0, _collections.chunkList)(values, opts?.chunk ?? DEFAULT_IN_CHUNK)) {
        const placeholders = bindList(chunk.length);
        const rows = (0, _connection.readRows)(conn, `SELECT * FROM ${schema.table}${prefix}${column} IN (${placeholders});`, [...rowFilter.params, ...chunk]);
        for (const row of rows) out.push(row);
      }
      return out;
    },
    has(where) {
      const cached = presence.get(where);
      if (cached !== undefined) return cached;
      const {
        sql,
        params
      } = (0, _query.whereClause)(where);
      const row = (0, _connection.readRows)(conn, `SELECT 1 AS one FROM ${schema.table}${sql} LIMIT 1;`, params)[0];
      presence.observe(where, !!row);
      return !!row;
    },
    getMeta(where) {
      const meta = schema.meta;
      if (!meta) return undefined;
      ensureMetaLoaded(meta);
      return metaCache.get(metaKey(where));
    },
    setMeta(where, value) {
      const meta = schema.meta;
      if (!meta) return;
      if (value === undefined) {
        ensureMetaLoaded(meta);
        if (metaCache.get(metaKey(where)) === undefined) return;
      }
      const keyCols = meta.keyColumns;
      const keyParams = keyCols.map(column => where[column]);
      const allCols = [...keyCols, meta.column];
      const placeholders = bindList(allCols.length);
      const params = value === undefined ? keyParams : [...keyParams, value];
      // Fire-and-forget: a synchronous write would block the JS thread on SQLite's writer lock.
      metaCache.set(metaKey(where), value);
      const sql = value === undefined ? `DELETE FROM ${meta.table} WHERE ${keyCols.map(column => `${column} = ?`).join(' AND ')};` : `INSERT OR REPLACE INTO ${meta.table} (${allCols.join(', ')}) VALUES (${placeholders});`;
      if (conn.executeAsync) {
        conn.executeAsync(sql, params).catch(() => {
          /* the in-session cache already holds the value */
        });
      } else {
        conn.execute(sql, params);
      }
    }
  };
}
//# sourceMappingURL=sqlite.js.map