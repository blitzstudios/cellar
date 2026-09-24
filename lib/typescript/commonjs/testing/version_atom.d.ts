/** A real {@link VersionAtom} that also records its bumps, for tests. */
import { VersionAtom } from '../reactivity/version_atom';
import { ChangeSet } from '../table/change_set';
/** Creates a {@link VersionAtom} that records each bump that changed something. */
export declare function createTestVersionAtom(root?: string): VersionAtom & {
    /** Each bumped partition's key parts joined with `:`, in order. */
    bumped: string[];
    /** The units each bump changed, in the same order. */
    bumpedWith: ChangeSet[];
};
//# sourceMappingURL=version_atom.d.ts.map