/**
 * The DDL a store's `init` runs and the migration plan that chooses it. A live schema is identified by a fingerprint
 * stamped into `PRAGMA user_version`, so a stamp that differs from the declared schema's forces a rebuild.
 */
import { IndexDef, MetaDef, RowShape, RowTableSchema } from './types';
import { NativeShredSpec } from '../write/shred_spec';
import { SqliteConnection } from './connection';
/** What `init` does with the table it found — build it, leave it alone, or drop and rebuild it — as {@link planSchemaMigration} decides. */
export type SchemaMigration = 'create' | 'none' | 'rebuild';
/**
 * The stamp identifying a built schema, hashed out of everything `init` creates, so that editing a schema rebuilds the
 * database rather than needing a migration. A change that alters what the rows hold without touching the columns,
 * key, indexes, ETag table or shred specs is invisible here — bump `schema.rebuildVersion` to force it.
 */
export declare function schemaFingerprint<Row extends RowShape>(schema: RowTableSchema<Row>, nativeShredSpec?: NativeShredSpec): number;
/** Chooses between creating, keeping, and rebuilding the table; a rebuild is the only repair SQLite offers here. */
export declare function planSchemaMigration<Row extends RowShape>(schema: RowTableSchema<Row>, live: {
    tableExists: boolean;
    stamp: number;
}, nativeShredSpec?: NativeShredSpec): SchemaMigration;
/**
 * The `CREATE TABLE` a store's `init` runs, spelling the columns in the `columns` object's key order — the order every
 * `INSERT` binds them in. An empty `primaryKey` emits no key clause, which is how a snapshot table keeps its duplicates.
 */
export declare function createTableSql<Row extends RowShape>(schema: RowTableSchema<Row>): string;
/**
 * The `CREATE TABLE` for the ETag side-table beside a row table, keyed by the columns that address a partition so each
 * partition holds one ETag. `init` builds it only for a schema declaring `meta`; a store without one refetches whole
 * bodies it already has, since it has nowhere to keep the ETag that would 304 them.
 */
export declare function createMetaTableSql<Row extends RowShape>(meta: MetaDef<Row>): string;
/**
 * The `CREATE INDEX` for one secondary index: run at `init`, and again by a bulk write that dropped its indexes to
 * rebuild them in a single sort. `IF NOT EXISTS` leaves an index of the same name over different columns in place, so
 * an edited index only reaches the database through the fingerprint.
 */
export declare const createIndexSql: <Row extends RowShape>(table: string, idx: IndexDef<Row>) => string;
/** The drop half of that pair, for a bulk write that rebuilds its indexes afterwards rather than maintaining them row by row. */
export declare const dropIndexSql: <Row extends RowShape>(idx: IndexDef<Row>) => string;
/** Reads a live database's schema stamp, `0` where nothing has stamped one, for `init` to weigh against {@link schemaFingerprint}. */
export declare function readUserVersion(conn: SqliteConnection): number;
/** Throws in `__DEV__`, reports in production. */
export declare function reportPushFedRebuild(table: string): void;
//# sourceMappingURL=schema.d.ts.map