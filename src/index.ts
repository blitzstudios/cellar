/**
 * The kernel's public surface: what a store definition, a service, or a screen imports. The pieces a store is built
 * out of are here; the pieces `definePartitions` and `defineSqliteStore` are built out of are not, and a store that
 * finds itself wanting one of those is reaching past its entry point.
 *
 * Everything here is something a consumer reaches for. A name a consumer never writes is not exported, even when the
 * kernel leans on it heavily inside — the type checker infers it at a call site, and `src/tests/public_surface.test.ts`
 * fails if this list grows without someone meaning it to. Test-only fixtures live behind `./testing` instead.
 */

// What the host installs before it binds a backend: where a report goes, the query runtime an ingest mounts on, and
// when a read is live.
export type { QueryClient, QuerySpec, QueryStatus, ReadGate, ReadGateRuntime } from './runtime';
export { configureDataKernel } from './runtime';

// Declaring a store.
export { defineSqliteStore } from './define_sqlite_store';
export { definePartitions } from './define_partitions';

// What a read hands back.
export type { DataStatus, DataResult } from './store_result';
export { DATA_RESULT_KEYS, makeResult } from './store_result';
export type { PrimeState } from './prime_state';

// What a store memoizes, declared through its partitions (`stats.memos({ … })`) so no caller builds a key.
export type { MemoDeclaration, MemoFactory, MemoPart, MemoSource } from './caches';
export { byVersion, bySource, shallowEqualArray, shallowEqualRecord, shallowEqualStruct, shallowEqualValue } from './caches';

// The table a store's schema describes, and the rows it holds.
export type { SqlValue, ColumnDef, RowTableSchema, RowTable } from './table/types';
export { createMemoryRowTable } from './table/memory';
export { createSqliteRowTable } from './table/sqlite';
export type { SqliteConnection, PinnedConnection } from './table/connection';
export { readRows, pinnedReader } from './table/connection';

// Getting rows in: a fetch a partition drives, and a socket feed a store drives itself.
export type { RawQuery } from './write/fetch_ingest';
export { RAW_TEXT_RESPONSE_TRANSFORM } from './write/fetch_ingest';
export { createPushIngest } from './write/push_ingest';
export type { ShredColumn, ShredColumns, RowOf } from './write/shred_columns';
export { defineShredColumns } from './write/shred_columns';
export type { ShredOp, ShredSpec, NativeShredSpec } from './write/shred_spec';

// Declaring reads, and turning rows into view models.
export { rowsOf } from './read/row_shaping';
export type { MaybeId, ReadOptions, Loose } from './read/facade';
export { pairRead } from './read/facade';
export type { WindowedBlock } from './read/windowed_list';
export { createWindowedList } from './read/windowed_list';
export type { RowProjection, RowProjectionDef } from './read/projection';

// Repainting on a write.
export type { VersionAtom } from './reactivity/version_atom';
export type { Dep } from './reactivity/tracking';
export { runTracked, runSubscribed } from './reactivity/tracking';
export { createTrackedSelector } from './reactivity/tracked_selector';

export { reportStoreDegradation } from './diagnostics/telemetry';
export { createOnceGuard } from './diagnostics/once_guard';
