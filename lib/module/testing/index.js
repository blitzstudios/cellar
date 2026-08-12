"use strict";

/**
 * Fixtures for a suite that exercises a store built on this kernel: a real SQLite engine off-device, a version atom
 * that recomputes on every read, the host services as spies, and the wrappers that pin a case to one build.
 */

export { createSqlJsConnection, initSqlJs } from "./sqljs_connection.js";
export { createTestVersionAtom } from "./version_atom.js";
export { installTestRuntime } from "./runtime.js";
export { itDev, itProd, describeDev, devWarnings } from "./dev_mode.js";
//# sourceMappingURL=index.js.map