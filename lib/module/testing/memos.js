"use strict";

/** A store's memos, for a suite that builds one module of a store rather than the whole backend. */

import { createMemos } from "../caches.js";
/**
 * The `memos` a `definePartitions` hands its hydration, for a test building that hydration directly. Pass the same atom
 * the module under test bumps, or a memo will answer from an entry the test thought it had invalidated, and `parts` for
 * a store whose key is an object rather than one string.
 */
export function testMemos(version, opts = {}) {
  const parts = opts.parts ?? (key => [key ?? '']);
  return decls => createMemos(opts.store ?? 'test', {
    parts,
    version: key => version.get(parts(key)),
    unitVersion: (key, unit) => version.getUnit(parts(key), unit)
  }, decls);
}
//# sourceMappingURL=memos.js.map