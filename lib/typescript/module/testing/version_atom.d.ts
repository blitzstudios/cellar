/**
 * A {@link VersionAtom} for tests: real `subscribe` and `bump`, hooks that recompute on every call, and a `bumped`
 * log naming every partition bumped, in order.
 */
import { VersionAtom } from '../reactivity/version_atom';
export declare function createTestVersionAtom(): VersionAtom & {
    bumped: string[];
};
//# sourceMappingURL=version_atom.d.ts.map