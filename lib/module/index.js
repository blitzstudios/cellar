"use strict";

/**
 * The kernel's public surface: what a store definition, a service, or a screen imports. The pieces a store is built
 * out of are here; the pieces `definePartitions` and `defineSqliteStore` are built out of are not, and a store that
 * finds itself wanting one of those is reaching past its entry point.
 *
 * Everything here is something a consumer reaches for. A name a consumer never writes is not exported, even when the
 * kernel leans on it heavily inside — the type checker infers it at a call site, and `src/tests/public_surface.test.ts`
 * fails if this list grows without someone meaning it to. Test-only fixtures live behind `./testing` instead.
 */

// What the host installs before it binds a store: where a report goes, the query runtime an ingest mounts on, and
// when a read is live.

export { configureDataKernel } from "./runtime.js";

// Declaring a store.
export { defineSqliteStore } from "./define_sqlite_store.js";
export { definePartitions } from "./define_partitions.js";

// What a read hands back.

export { DATA_RESULT_KEYS, makeResult } from "./store_result.js";

// What a store memoizes, declared through its partitions (`stats.memos({ … })`) so no caller builds a key.

export { byVersion, byUnit, shallowEqualArray, shallowEqualRecord, shallowEqualStruct, shallowEqualValue } from "./caches.js";

// The table a store's schema describes, and the rows it holds.

export { ALL_UNITS, NO_CHANGES } from "./table/change_set.js";
export { createSqliteRowTable } from "./table/sqlite.js";
export { readRows, pinnedReader } from "./table/connection.js";

// Getting rows in: a fetch a partition drives, and a socket feed a store drives itself.

export { RAW_TEXT_RESPONSE_TRANSFORM } from "./write/fetch_ingest.js";
export { createPushIngest } from "./write/push_ingest.js";
export { defineShredColumns } from "./write/shred_columns.js";
// Declaring reads, and turning rows into view models.
export { rowsOf } from "./read/row_shaping.js";
export { pairRead } from "./read/facade.js";
export { createWindowedList } from "./read/windowed_list.js";

// Repainting on a write.

export { runTracked, runSubscribed } from "./reactivity/tracking.js";
export { createTrackedSelector } from "./reactivity/tracked_selector.js";
export { useTrackedValue } from "./reactivity/tracked_value.js";
export { reportStoreDegradation } from "./diagnostics/telemetry.js";
export { createOnceGuard } from "./diagnostics/once_guard.js";
//# sourceMappingURL=index.js.map