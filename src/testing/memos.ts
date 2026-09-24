/** A store's memos, for a suite that builds one module of a store rather than the whole store. */

import { createMemos, MemoFactory } from '../caches';
import { VersionAtom } from '../reactivity/version_atom';

/**
 * A `memos` function like the one `definePartitions` gives a store's modules, for testing a module on its own. Pass the
 * version atom the test bumps, or its memos won't see the writes.
 */
export function testMemos<Key = string>(
  version: VersionAtom,
  opts: {
    /** The store name shown in warnings; `test` by default. */
    store?: string;
    /** A key's parts, for a key that isn't a single string. */
    parts?: (key: Key) => readonly string[];
  } = {},
): MemoFactory<Key> {
  const parts = opts.parts ?? ((key: Key) => [(key as unknown as string) ?? '']);
  return (decls) =>
    createMemos(opts.store ?? 'test', { parts, version: (key) => version.get(parts(key)), unitVersion: (key, unit) => version.getUnit(parts(key), unit) }, decls);
}
