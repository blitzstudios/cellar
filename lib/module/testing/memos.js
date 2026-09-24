"use strict";

/** A store's memos, for a suite that builds one module of a store rather than the whole store. */

import { createMemos } from "../caches.js";
/**
 * A `memos` function like the one `definePartitions` gives a store's modules, for testing a module on its own. Pass the
 * version atom the test bumps, or its memos won't see the writes.
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