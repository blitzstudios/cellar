"use strict";

/**
 * A {@link VersionAtom} for tests: the real one, so reads report and subscribe exactly as they do in the app, plus a
 * `bumped` log naming every partition bumped, in order, and `bumpedWith` holding the units each bump carried.
 */

import { createVersionAtom } from "../reactivity/version_atom.js";
import { ALL_UNITS, isUnchanged } from "../table/change_set.js";
export function createTestVersionAtom(root = 'test_version') {
  const atom = createVersionAtom(root);
  const realBump = atom.bump;
  const bumped = [];
  const bumpedWith = [];
  const bump = (parts, changes = ALL_UNITS) => {
    if (!isUnchanged(changes)) {
      bumped.push(parts.join(':'));
      bumpedWith.push(changes);
    }
    return realBump(parts, changes);
  };
  return Object.assign(atom, {
    bump,
    bumped,
    bumpedWith
  });
}
//# sourceMappingURL=version_atom.js.map