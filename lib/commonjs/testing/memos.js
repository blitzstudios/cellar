"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.testMemos = testMemos;
var _caches = require("../caches.js");
/** A store's memos, for a suite that builds one module of a store rather than the whole store. */

/**
 * A {@linkcode Partitions.memos | memos} function like the one {@linkcode definePartitions} gives a store's modules,
 * for testing a module on its own. Pass the version atom the test bumps, or its memos won't see the writes.
 */
function testMemos(version, opts = {}) {
  const parts = opts.parts ?? (key => [key ?? '']);
  return decls => (0, _caches.createMemos)(opts.store ?? 'test', {
    parts,
    version: key => version.get(parts(key)),
    unitVersion: (key, unit) => version.getUnit(parts(key), unit)
  }, decls);
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=memos.js.map