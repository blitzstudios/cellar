/**
 * The kernel's public surface: what a store definition, a service, or a screen imports. The pieces a store is built
 * out of are here; the pieces `definePartitions` and `defineSqliteStore` are built out of are not, and a store that
 * finds itself wanting one of those is reaching past its entry point.
 *
 * Everything here is something a consumer reaches for. A name a consumer never writes is not exported, even when the
 * kernel leans on it heavily inside — the type checker infers it at a call site, and `src/tests/public_surface.test.ts`
 * fails if this list grows without someone meaning it to. Test-only fixtures live behind `./testing` instead.
 */
export type { QueryClient, QuerySpec, QueryStatus, ReadGate, ReadGateRuntime } from './runtime';
export { configureDataKernel } from './runtime';
export { defineSqliteStore } from './define_sqlite_store';
export { definePartitions } from './define_partitions';
export type { DataStatus, DataResult } from './store_result';
export { DATA_RESULT_KEYS, makeResult } from './store_result';
export type { PrimeState } from './prime_state';
export type { MemoDeclaration, MemoFactory, MemoPart } from './caches';
export { byVersion, byUnit, shallowEqualArray, shallowEqualRecord, shallowEqualStruct, shallowEqualValue } from './caches';
export type { SqlValue, ColumnDef, RowTableSchema, RowTable } from './table/types';
export type { ChangeSet, WriteResult } from './table/change_set';
export { ALL_UNITS, NO_CHANGES } from './table/change_set';
export { createMemoryRowTable } from './table/memory';
export { createSqliteRowTable } from './table/sqlite';
export type { SqliteConnection, PinnedConnection } from './table/connection';
export { readRows, pinnedReader } from './table/connection';
export type { RawQuery } from './write/fetch_ingest';
export { RAW_TEXT_RESPONSE_TRANSFORM } from './write/fetch_ingest';
export { createPushIngest } from './write/push_ingest';
export type { ShredColumn, ShredColumns, RowOf } from './write/shred_columns';
export { defineShredColumns } from './write/shred_columns';
export type { ShredOp, ShredSpec, NativeShredSpec } from './write/shred_spec';
export { rowsOf } from './read/row_shaping';
export type { MaybeId, ReadOptions, Loose } from './read/facade';
export { pairRead } from './read/facade';
export type { WindowedBlock } from './read/windowed_list';
export { createWindowedList } from './read/windowed_list';
export type { RowProjection, RowProjectionDef } from './read/projection';
export type { VersionAtom } from './reactivity/version_atom';
export type { Dep } from './reactivity/tracking';
export { runTracked, runSubscribed } from './reactivity/tracking';
export { createTrackedSelector } from './reactivity/tracked_selector';
export type { TrackedValueOptions } from './reactivity/tracked_value';
export { useTrackedValue } from './reactivity/tracked_value';
export { reportStoreDegradation } from './diagnostics/telemetry';
export { createOnceGuard } from './diagnostics/once_guard';
//# sourceMappingURL=index.d.ts.map