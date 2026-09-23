/**
 * A {@link VersionAtom} for tests: the real one, so reads report and subscribe exactly as they do in the app, plus a
 * `bumped` log naming every partition bumped, in order, and `bumpedWith` holding the units each bump carried.
 */
import { VersionAtom } from '../reactivity/version_atom';
import { ChangeSet } from '../table/change_set';
export declare function createTestVersionAtom(root?: string): VersionAtom & {
    bumped: string[];
    bumpedWith: ChangeSet[];
};
//# sourceMappingURL=version_atom.d.ts.map