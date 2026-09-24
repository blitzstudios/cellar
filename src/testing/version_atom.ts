/** A real {@link VersionAtom} that also records its bumps, for tests. */

import { createVersionAtom, VersionAtom } from '../reactivity/version_atom';
import { ALL_UNITS, ChangeSet, isUnchanged } from '../table/change_set';

/** Creates a {@link VersionAtom} that records each bump that changed something. */
export function createTestVersionAtom(root = 'test_version'): VersionAtom & {
  /** Each bumped partition's key parts joined with `:`, in order. */
  bumped: string[];
  /** The units each bump changed, in the same order. */
  bumpedWith: ChangeSet[];
} {
  const atom = createVersionAtom(root);
  const realBump = atom.bump;
  const bumped: string[] = [];
  const bumpedWith: ChangeSet[] = [];
  const bump: VersionAtom['bump'] = (parts, changes = ALL_UNITS) => {
    if (!isUnchanged(changes)) {
      bumped.push(parts.join(':'));
      bumpedWith.push(changes);
    }
    return realBump(parts, changes);
  };
  return Object.assign(atom, { bump, bumped, bumpedWith });
}
