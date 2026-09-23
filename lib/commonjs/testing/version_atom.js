"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createTestVersionAtom = createTestVersionAtom;
var _version_atom = require("../reactivity/version_atom.js");
var _change_set = require("../table/change_set.js");
/**
 * A {@link VersionAtom} for tests: the real one, so reads report and subscribe exactly as they do in the app, plus a
 * `bumped` log naming every partition bumped, in order, and `bumpedWith` holding the units each bump carried.
 */

function createTestVersionAtom(root = 'test_version') {
  const atom = (0, _version_atom.createVersionAtom)(root);
  const realBump = atom.bump;
  const bumped = [];
  const bumpedWith = [];
  const bump = (parts, changes = _change_set.ALL_UNITS) => {
    if (!(0, _change_set.isUnchanged)(changes)) {
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