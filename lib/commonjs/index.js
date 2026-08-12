"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
Object.defineProperty(exports, "DATA_RESULT_KEYS", {
  enumerable: true,
  get: function () {
    return _store_result.DATA_RESULT_KEYS;
  }
});
Object.defineProperty(exports, "INERT_ERRORS", {
  enumerable: true,
  get: function () {
    return _runtime.INERT_ERRORS;
  }
});
Object.defineProperty(exports, "INERT_QUERY", {
  enumerable: true,
  get: function () {
    return _runtime.INERT_QUERY;
  }
});
Object.defineProperty(exports, "KEY_SEP", {
  enumerable: true,
  get: function () {
    return _args_key.KEY_SEP;
  }
});
Object.defineProperty(exports, "RAW_TEXT_RESPONSE_TRANSFORM", {
  enumerable: true,
  get: function () {
    return _fetch_ingest.RAW_TEXT_RESPONSE_TRANSFORM;
  }
});
Object.defineProperty(exports, "bySource", {
  enumerable: true,
  get: function () {
    return _caches.bySource;
  }
});
Object.defineProperty(exports, "byVersion", {
  enumerable: true,
  get: function () {
    return _caches.byVersion;
  }
});
Object.defineProperty(exports, "cacheKey", {
  enumerable: true,
  get: function () {
    return _args_key.cacheKey;
  }
});
Object.defineProperty(exports, "configureDataKernel", {
  enumerable: true,
  get: function () {
    return _runtime.configureDataKernel;
  }
});
Object.defineProperty(exports, "createBoundedLru", {
  enumerable: true,
  get: function () {
    return _caches.createBoundedLru;
  }
});
Object.defineProperty(exports, "createMemoryRowTable", {
  enumerable: true,
  get: function () {
    return _memory.createMemoryRowTable;
  }
});
Object.defineProperty(exports, "createOnceGuard", {
  enumerable: true,
  get: function () {
    return _once_guard.createOnceGuard;
  }
});
Object.defineProperty(exports, "createPushIngest", {
  enumerable: true,
  get: function () {
    return _push_ingest.createPushIngest;
  }
});
Object.defineProperty(exports, "createSqliteRowTable", {
  enumerable: true,
  get: function () {
    return _sqlite.createSqliteRowTable;
  }
});
Object.defineProperty(exports, "createTrackedSelector", {
  enumerable: true,
  get: function () {
    return _tracked_selector.createTrackedSelector;
  }
});
Object.defineProperty(exports, "createVersionAtom", {
  enumerable: true,
  get: function () {
    return _version_atom.createVersionAtom;
  }
});
Object.defineProperty(exports, "createWindowedList", {
  enumerable: true,
  get: function () {
    return _windowed_list.createWindowedList;
  }
});
Object.defineProperty(exports, "declareMemos", {
  enumerable: true,
  get: function () {
    return _caches.declareMemos;
  }
});
Object.defineProperty(exports, "definePartitions", {
  enumerable: true,
  get: function () {
    return _define_partitions.definePartitions;
  }
});
Object.defineProperty(exports, "defineSqliteStore", {
  enumerable: true,
  get: function () {
    return _define_sqlite_store.defineSqliteStore;
  }
});
Object.defineProperty(exports, "evalShredElement", {
  enumerable: true,
  get: function () {
    return _shred_spec.evalShredElement;
  }
});
Object.defineProperty(exports, "getIngestTimings", {
  enumerable: true,
  get: function () {
    return _ingest_timing.getIngestTimings;
  }
});
Object.defineProperty(exports, "groupRowsBy", {
  enumerable: true,
  get: function () {
    return _row_shaping.groupRowsBy;
  }
});
Object.defineProperty(exports, "indexRowsBy", {
  enumerable: true,
  get: function () {
    return _row_shaping.indexRowsBy;
  }
});
Object.defineProperty(exports, "isLive", {
  enumerable: true,
  get: function () {
    return _version_atom.isLive;
  }
});
Object.defineProperty(exports, "makeResult", {
  enumerable: true,
  get: function () {
    return _store_result.makeResult;
  }
});
Object.defineProperty(exports, "mapRows", {
  enumerable: true,
  get: function () {
    return _row_shaping.mapRows;
  }
});
Object.defineProperty(exports, "orderedByIds", {
  enumerable: true,
  get: function () {
    return _row_shaping.orderedByIds;
  }
});
Object.defineProperty(exports, "pairRead", {
  enumerable: true,
  get: function () {
    return _facade.pairRead;
  }
});
Object.defineProperty(exports, "pinnedReader", {
  enumerable: true,
  get: function () {
    return _connection.pinnedReader;
  }
});
Object.defineProperty(exports, "readRows", {
  enumerable: true,
  get: function () {
    return _connection.readRows;
  }
});
Object.defineProperty(exports, "reportStoreDegradation", {
  enumerable: true,
  get: function () {
    return _telemetry.reportStoreDegradation;
  }
});
Object.defineProperty(exports, "resetOnceGuards", {
  enumerable: true,
  get: function () {
    return _once_guard.resetOnceGuards;
  }
});
Object.defineProperty(exports, "rollupIngestTimings", {
  enumerable: true,
  get: function () {
    return _ingest_timing.rollupIngestTimings;
  }
});
Object.defineProperty(exports, "runSubscribed", {
  enumerable: true,
  get: function () {
    return _tracking.runSubscribed;
  }
});
Object.defineProperty(exports, "runTracked", {
  enumerable: true,
  get: function () {
    return _tracking.runTracked;
  }
});
Object.defineProperty(exports, "shallowEqualArray", {
  enumerable: true,
  get: function () {
    return _caches.shallowEqualArray;
  }
});
Object.defineProperty(exports, "shallowEqualRecord", {
  enumerable: true,
  get: function () {
    return _caches.shallowEqualRecord;
  }
});
Object.defineProperty(exports, "shallowEqualStruct", {
  enumerable: true,
  get: function () {
    return _caches.shallowEqualStruct;
  }
});
Object.defineProperty(exports, "shredColumnDefs", {
  enumerable: true,
  get: function () {
    return _shred_columns.shredColumnDefs;
  }
});
Object.defineProperty(exports, "shredColumnNames", {
  enumerable: true,
  get: function () {
    return _shred_columns.shredColumnNames;
  }
});
Object.defineProperty(exports, "shredColumnOps", {
  enumerable: true,
  get: function () {
    return _shred_columns.shredColumnOps;
  }
});
Object.defineProperty(exports, "shredRow", {
  enumerable: true,
  get: function () {
    return _shred_columns.shredRow;
  }
});
Object.defineProperty(exports, "stableKey", {
  enumerable: true,
  get: function () {
    return _args_key.stableKey;
  }
});
var _runtime = require("./runtime.js");
var _define_sqlite_store = require("./define_sqlite_store.js");
var _define_partitions = require("./define_partitions.js");
var _store_result = require("./store_result.js");
var _args_key = require("./args_key.js");
var _caches = require("./caches.js");
var _memory = require("./table/memory.js");
var _sqlite = require("./table/sqlite.js");
var _connection = require("./table/connection.js");
var _fetch_ingest = require("./write/fetch_ingest.js");
var _push_ingest = require("./write/push_ingest.js");
var _shred_columns = require("./write/shred_columns.js");
var _shred_spec = require("./write/shred_spec.js");
var _row_shaping = require("./read/row_shaping.js");
var _facade = require("./read/facade.js");
var _windowed_list = require("./read/windowed_list.js");
var _version_atom = require("./reactivity/version_atom.js");
var _tracking = require("./reactivity/tracking.js");
var _tracked_selector = require("./reactivity/tracked_selector.js");
var _telemetry = require("./diagnostics/telemetry.js");
var _ingest_timing = require("./diagnostics/ingest_timing.js");
var _once_guard = require("./diagnostics/once_guard.js");
//# sourceMappingURL=index.js.map