/**
 * The DDL a store's `init` runs and the migration plan that chooses it. A live schema is identified by a fingerprint
 * stamped into `PRAGMA user_version`, so a stamp that differs from the declared schema's forces a rebuild.
 */

import { cacheKey, GROUP_SEP } from '../args_key';
import { columnNames, IndexDef, MetaDef, RowShape, RowTableSchema } from './types';
import { NativeShredSpec } from '../write/shred_spec';
import { readRows, SqliteConnection } from './connection';
import { reportStoreDegradation } from '../diagnostics/telemetry';

/** What `init` does with the table it found — build it, leave it alone, or drop and rebuild it — as {@link planSchemaMigration} decides. */
export type SchemaMigration = 'create' | 'none' | 'rebuild';

/** 32-bit FNV-1a. `PRAGMA user_version` is a signed 32-bit int, so the stamp has to fit in one. */
function fnv1a32(input: string): number {
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
function shredFingerprint(nativeShredSpec?: NativeShredSpec): string {
  if (!nativeShredSpec) return '';
  return Object.keys(nativeShredSpec.specs)
    .sort()
    .map((variant) => `${variant}=${JSON.stringify(nativeShredSpec.specs[variant])}`)
    .join(GROUP_SEP);
}

/**
 * The stamp identifying a built schema, hashed out of everything `init` creates, so that editing a schema rebuilds the
 * database rather than needing a migration. A change that alters what the rows hold without touching the columns,
 * key, indexes, ETag table or shred specs is invisible here — bump `schema.rebuildVersion` to force it.
 */
export function schemaFingerprint<Row extends RowShape>(schema: RowTableSchema<Row>, nativeShredSpec?: NativeShredSpec): number {
  const cols = columnNames(schema).map((column) => `${column}:${schema.columns[column].type}:${schema.columns[column].notNull ? 1 : 0}`);
  // Sorted, so only a real index change moves the fingerprint.
  const indexes = (schema.indexes ?? []).map((index) => `${index.name}(${index.columns.join(',')})`).sort();
  const meta = schema.meta ? `${schema.meta.table}(${schema.meta.keyColumns.join(',')}):${schema.meta.column}` : '';
  const canonical = cacheKey(
    `r${schema.rebuildVersion ?? 0}`,
    schema.table,
    cols.join('|'),
    `pk(${schema.primaryKey.join(',')})`,
    indexes.join('|'),
    meta,
    shredFingerprint(nativeShredSpec),
  );
  // 0 is reserved for an unstamped database, so the stamp steps past it.
  return fnv1a32(canonical) || 1;
}

/** Chooses between creating, keeping, and rebuilding the table; a rebuild is the only repair SQLite offers here. */
export function planSchemaMigration<Row extends RowShape>(
  schema: RowTableSchema<Row>,
  live: { tableExists: boolean; stamp: number },
  nativeShredSpec?: NativeShredSpec,
): SchemaMigration {
  if (!live.tableExists) return 'create';
  return live.stamp === schemaFingerprint(schema, nativeShredSpec) ? 'none' : 'rebuild';
}

/**
 * The `CREATE TABLE` a store's `init` runs, spelling the columns in the `columns` object's key order — the order every
 * `INSERT` binds them in. An empty `primaryKey` emits no key clause, which is how a snapshot table keeps its duplicates.
 */
export function createTableSql<Row extends RowShape>(schema: RowTableSchema<Row>): string {
  const cols = columnNames(schema).map((column) => {
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
export function createMetaTableSql<Row extends RowShape>(meta: MetaDef<Row>): string {
  const keyCols = meta.keyColumns.map((column) => `  ${column} TEXT NOT NULL`);
  const lines = [...keyCols, `  ${meta.column} TEXT`, `  PRIMARY KEY (${meta.keyColumns.join(', ')})`];
  return `CREATE TABLE IF NOT EXISTS ${meta.table} (\n${lines.join(',\n')}\n);`;
}

/**
 * The `CREATE INDEX` for one secondary index: run at `init`, and again by a bulk write that dropped its indexes to
 * rebuild them in a single sort. `IF NOT EXISTS` leaves an index of the same name over different columns in place, so
 * an edited index only reaches the database through the fingerprint.
 */
export const createIndexSql = <Row extends RowShape>(table: string, idx: IndexDef<Row>): string =>
  `CREATE INDEX IF NOT EXISTS ${idx.name} ON ${table} (${idx.columns.join(', ')});`;

/** The drop half of that pair, for a bulk write that rebuilds its indexes afterwards rather than maintaining them row by row. */
export const dropIndexSql = <Row extends RowShape>(idx: IndexDef<Row>): string => `DROP INDEX IF EXISTS ${idx.name};`;

/** Reads a live database's schema stamp, `0` where nothing has stamped one, for `init` to weigh against {@link schemaFingerprint}. */
export function readUserVersion(conn: SqliteConnection): number {
  const rows = readRows<{ user_version?: number }>(conn, 'PRAGMA user_version;');
  return rows[0]?.user_version ?? 0;
}

/** Throws in `__DEV__`, reports in production. */
export function reportPushFedRebuild(table: string): void {
  const message =
    `[${table}] a schema change forces a rebuild of a push-fed table, which drops rows no fetch will bring back. ` +
    'Either keep the schema compatible, or add a backfill for this table before changing it.';
  if (__DEV__) throw new Error(message);
  reportStoreDegradation({ scope: `${table}.schema_rebuild`, context: message });
}
