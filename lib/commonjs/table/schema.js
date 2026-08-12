"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createIndexSql = void 0;
exports.createMetaTableSql = createMetaTableSql;
exports.createTableSql = createTableSql;
exports.dropIndexSql = void 0;
exports.planSchemaMigration = planSchemaMigration;
exports.readUserVersion = readUserVersion;
exports.reportPushFedRebuild = reportPushFedRebuild;
exports.schemaFingerprint = schemaFingerprint;
var _args_key = require("../args_key.js");
var _types = require("./types.js");
var _connection = require("./connection.js");
var _telemetry = require("../diagnostics/telemetry.js");
/**
 * The DDL a store's `init` runs and the migration plan that chooses it. A live schema is identified by a fingerprint
 * stamped into `PRAGMA user_version`, so a stamp that differs from the declared schema's forces a rebuild.
 */

/** What `init` does with the table it found — build it, leave it alone, or drop and rebuild it — as {@link planSchemaMigration} decides. */

/** 32-bit FNV-1a. `PRAGMA user_version` is a signed 32-bit int, so the stamp has to fit in one. */
function fnv1a32(input) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/**
 * The shred specs' contribution to the stamp hashed into `PRAGMA user_version`. Any change to how this string is
 * built rebuilds every installed database, which for a push-fed table drops rows only a new push can restore.
 */
function shredFingerprint(nativeShredSpec) {
  if (!nativeShredSpec) return '';
  return Object.keys(nativeShredSpec.specs).sort().map(variant => `${variant}=${JSON.stringify(nativeShredSpec.specs[variant])}`).join(_args_key.GROUP_SEP);
}

/**
 * The stamp identifying a built schema, hashed out of everything `init` creates, so that editing a schema rebuilds the
 * database rather than needing a migration. A change that alters what the rows hold without touching the columns,
 * key, indexes, ETag table or shred specs is invisible here — bump `schema.rebuildVersion` to force it.
 */
function schemaFingerprint(schema, nativeShredSpec) {
  const cols = (0, _types.columnNames)(schema).map(column => `${column}:${schema.columns[column].type}:${schema.columns[column].notNull ? 1 : 0}`);
  // Sorted, so only a real index change moves the fingerprint.
  const indexes = (schema.indexes ?? []).map(index => `${index.name}(${index.columns.join(',')})`).sort();
  const meta = schema.meta ? `${schema.meta.table}(${schema.meta.keyColumns.join(',')}):${schema.meta.column}` : '';
  const canonical = (0, _args_key.cacheKey)(`r${schema.rebuildVersion ?? 0}`, schema.table, cols.join('|'), `pk(${schema.primaryKey.join(',')})`, indexes.join('|'), meta, shredFingerprint(nativeShredSpec));
  // 0 is reserved for an unstamped database, so the stamp steps past it.
  return fnv1a32(canonical) || 1;
}

/** Chooses between creating, keeping, and rebuilding the table; a rebuild is the only repair SQLite offers here. */
function planSchemaMigration(schema, live, nativeShredSpec) {
  if (!live.tableExists) return 'create';
  return live.stamp === schemaFingerprint(schema, nativeShredSpec) ? 'none' : 'rebuild';
}

/**
 * The `CREATE TABLE` a store's `init` runs, spelling the columns in the `columns` object's key order — the order every
 * `INSERT` binds them in. An empty `primaryKey` emits no key clause, which is how a snapshot table keeps its duplicates.
 */
function createTableSql(schema) {
  const cols = (0, _types.columnNames)(schema).map(column => {
    const def = schema.columns[column];
    return `  ${column} ${def.type}${def.notNull ? ' NOT NULL' : ''}`;
  });
  const lines = [...cols];
  if (schema.primaryKey.length) lines.push(`  PRIMARY KEY (${schema.primaryKey.join(', ')})`);
  return `CREATE TABLE IF NOT EXISTS ${schema.table} (\n${lines.join(',\n')}\n);`;
}

/**
 * The `CREATE TABLE` for the ETag side-table beside a row table, keyed by the columns that address a partition so each
 * partition holds one ETag. `init` builds it only for a schema declaring `meta`; a store without one refetches whole
 * bodies it already has, since it has nowhere to keep the ETag that would 304 them.
 */
function createMetaTableSql(meta) {
  const keyCols = meta.keyColumns.map(column => `  ${column} TEXT NOT NULL`);
  const lines = [...keyCols, `  ${meta.column} TEXT`, `  PRIMARY KEY (${meta.keyColumns.join(', ')})`];
  return `CREATE TABLE IF NOT EXISTS ${meta.table} (\n${lines.join(',\n')}\n);`;
}

/**
 * The `CREATE INDEX` for one secondary index: run at `init`, and again by a bulk write that dropped its indexes to
 * rebuild them in a single sort. `IF NOT EXISTS` leaves an index of the same name over different columns in place, so
 * an edited index only reaches the database through the fingerprint.
 */
const createIndexSql = (table, idx) => `CREATE INDEX IF NOT EXISTS ${idx.name} ON ${table} (${idx.columns.join(', ')});`;

/** The drop half of that pair, for a bulk write that rebuilds its indexes afterwards rather than maintaining them row by row. */
exports.createIndexSql = createIndexSql;
const dropIndexSql = idx => `DROP INDEX IF EXISTS ${idx.name};`;

/** Reads a live database's schema stamp, `0` where nothing has stamped one, for `init` to weigh against {@link schemaFingerprint}. */
exports.dropIndexSql = dropIndexSql;
function readUserVersion(conn) {
  const rows = (0, _connection.readRows)(conn, 'PRAGMA user_version;');
  return rows[0]?.user_version ?? 0;
}

/** Throws in `__DEV__`, reports in production. */
function reportPushFedRebuild(table) {
  const message = `[${table}] a schema change forces a rebuild of a push-fed table, which drops rows no fetch will bring back. ` + 'Either keep the schema compatible, or add a backfill for this table before changing it.';
  if (__DEV__) throw new Error(message);
  (0, _telemetry.reportStoreDegradation)({
    scope: `${table}.schema_rebuild`,
    context: message
  });
}
//# sourceMappingURL=schema.js.map