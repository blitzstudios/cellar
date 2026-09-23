/**
 * A {@link VersionAtom} for tests: the real one, so reads report and subscribe exactly as they do in the app, plus a
 * `bumped` log naming every partition bumped, in order, and `bumpedWith` holding the units each bump carried.
 */

import { createVersionAtom, VersionAtom } from '../reactivity/version_atom';
import { ALL_UNITS, ChangeSet, isUnchanged } from '../table/change_set';

export function createTestVersionAtom(root = 'test_version'): VersionAtom & { bumped: string[]; bumpedWith: ChangeSet[] } {
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
