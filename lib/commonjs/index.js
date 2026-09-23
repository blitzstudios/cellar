"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
Object.defineProperty(exports, "ALL_UNITS", {
  enumerable: true,
  get: function () {
    return _change_set.ALL_UNITS;
  }
});
Object.defineProperty(exports, "DATA_RESULT_KEYS", {
  enumerable: true,
  get: function () {
    return _store_result.DATA_RESULT_KEYS;
  }
});
Object.defineProperty(exports, "NO_CHANGES", {
  enumerable: true,
  get: function () {
    return _change_set.NO_CHANGES;
  }
});
Object.defineProperty(exports, "RAW_TEXT_RESPONSE_TRANSFORM", {
  enumerable: true,
  get: function () {
    return _fetch_ingest.RAW_TEXT_RESPONSE_TRANSFORM;
  }
});
Object.defineProperty(exports, "byUnit", {
  enumerable: true,
  get: function () {
    return _caches.byUnit;
  }
});
Object.defineProperty(exports, "byVersion", {
  enumerable: true,
  get: function () {
    return _caches.byVersion;
  }
});
Object.defineProperty(exports, "configureDataKernel", {
  enumerable: true,
  get: function () {
    return _runtime.configureDataKernel;
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
Object.defineProperty(exports, "createWindowedList", {
  enumerable: true,
  get: function () {
    return _windowed_list.createWindowedList;
  }
});
Object.defineProperty(exports, "definePartitions", {
  enumerable: true,
  get: function () {
    return _define_partitions.definePartitions;
  }
});
Object.defineProperty(exports, "defineShredColumns", {
  enumerable: true,
  get: function () {
    return _shred_columns.defineShredColumns;
  }
});
Object.defineProperty(exports, "defineSqliteStore", {
  enumerable: true,
  get: function () {
    return _define_sqlite_store.defineSqliteStore;
  }
});
Object.defineProperty(exports, "makeResult", {
  enumerable: true,
  get: function () {
    return _store_result.makeResult;
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
Object.defineProperty(exports, "rowsOf", {
  enumerable: true,
  get: function () {
    return _row_shaping.rowsOf;
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
Object.defineProperty(exports, "shallowEqualValue", {
  enumerable: true,
  get: function () {
    return _caches.shallowEqualValue;
  }
});
Object.defineProperty(exports, "useTrackedValue", {
  enumerable: true,
  get: function () {
    return _tracked_value.useTrackedValue;
  }
});
var _runtime = require("./runtime.js");
var _define_sqlite_store = require("./define_sqlite_store.js");
var _define_partitions = require("./define_partitions.js");
var _store_result = require("./store_result.js");
var _caches = require("./caches.js");
var _change_set = require("./table/change_set.js");
var _sqlite = require("./table/sqlite.js");
var _connection = require("./table/connection.js");
var _fetch_ingest = require("./write/fetch_ingest.js");
var _push_ingest = require("./write/push_ingest.js");
var _shred_columns = require("./write/shred_columns.js");
var _row_shaping = require("./read/row_shaping.js");
var _facade = require("./read/facade.js");
var _windowed_list = require("./read/windowed_list.js");
var _tracking = require("./reactivity/tracking.js");
var _tracked_selector = require("./reactivity/tracked_selector.js");
var _tracked_value = require("./reactivity/tracked_value.js");
var _telemetry = require("./diagnostics/telemetry.js");
var _once_guard = require("./diagnostics/once_guard.js");
//# sourceMappingURL=index.js.map