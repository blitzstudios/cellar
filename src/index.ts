/**
 * The kernel's public surface: what a store definition, a service, or a screen imports. The pieces a store is built
 * out of are here; the pieces `definePartitions` and `defineSqliteStore` are built out of are not, and a store that
 * finds itself wanting one of those is reaching past its entry point.
 */

// What the host installs before it binds a backend: where a report goes, and the query runtime an ingest mounts on.
export type { DataKernelRuntime, ErrorSink, CaptureContext, QueryRuntime, QueryClient, QuerySpec, QueryStatus, QueryKey } from './runtime';
export { configureDataKernel, INERT_ERRORS, INERT_QUERY } from './runtime';

// Declaring a store.
export type { SqliteStore, SqliteStoreConfig, StoreCapabilities, StoreBackendShape } from './define_sqlite_store';
export { defineSqliteStore } from './define_sqlite_store';
export type { Partitions, PartitionsConfig, PartitionKeySpec, PartitionFetchSpec } from './define_partitions';
export { definePartitions } from './define_partitions';

// What a read hands back.
export type { DataStatus, DataResult } from './store_result';
export { DATA_RESULT_KEYS, makeResult } from './store_result';
export type { PrimeState } from './prime_state';

export { cacheKey, KEY_SEP, stableKey } from './args_key';
export type { VersionedCache, VersionedSourceCache } from './caches';
export { createBoundedLru, declareMemos, byVersion, bySource, shallowEqualRecord, shallowEqualArray, shallowEqualStruct } from './caches';

// The table a store's schema describes, and the rows it holds.
export type { SqlValue, RowShape, ColumnDef, ColumnType, IndexDef, MetaDef, RowTableSchema, RowTable, FindOpts } from './table/types';
export { createMemoryRowTable } from './table/memory';
export { createSqliteRowTable } from './table/sqlite';
export type { SqliteConnection, PinnedConnection } from './table/connection';
export { readRows, pinnedReader } from './table/connection';

// Getting rows in: a fetch a partition drives, and a socket feed a store drives itself.
export type { RawQuery } from './write/fetch_ingest';
export { RAW_TEXT_RESPONSE_TRANSFORM } from './write/fetch_ingest';
export type { PushIngestConfig, PushIngest } from './write/push_ingest';
export { createPushIngest } from './write/push_ingest';
export type { ShredColumn, RowOf } from './write/shred_columns';
export { shredColumnDefs, shredColumnNames, shredColumnOps, shredRow } from './write/shred_columns';
export type { ShredOp, ConcatPart, ShredDeleteClause, ShredSpec, NativeShredSpec } from './write/shred_spec';
export { evalShredElement } from './write/shred_spec';

// Declaring reads, and turning rows into view models.
export type { ReadDef, ReadManyDef, Read } from './read/surface';
export { groupRowsBy, indexRowsBy, mapRows, orderedByIds } from './read/row_shaping';
export type { PartitionField, VaryField } from './read/partition_fields';
export type { PairedRead, MaybeId, ReadOptions, Loose } from './read/facade';
export { pairRead } from './read/facade';
export type { WindowedListSpec, WindowedList, WindowedBlock } from './read/windowed_list';
export { createWindowedList } from './read/windowed_list';

// Repainting on a write.
export type { VersionAtom } from './reactivity/version_atom';
export { createVersionAtom, isLive } from './reactivity/version_atom';
export type { Dep } from './reactivity/tracking';
export { runTracked, runSubscribed } from './reactivity/tracking';
export type { EqualityFn } from './reactivity/tracked_selector';
export { createTrackedSelector } from './reactivity/tracked_selector';

export { reportStoreDegradation } from './diagnostics/telemetry';
export { getIngestTimings, rollupIngestTimings } from './diagnostics/ingest_timing';
export { createOnceGuard, resetOnceGuards } from './diagnostics/once_guard';
