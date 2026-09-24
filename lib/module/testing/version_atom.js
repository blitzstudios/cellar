"use strict";

/** A real {@link VersionAtom} that also records its bumps, for tests. */

import { createVersionAtom } from "../reactivity/version_atom.js";
import { ALL_UNITS, isUnchanged } from "../table/change_set.js";

/** Creates a {@link VersionAtom} that records each bump that changed something. */
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