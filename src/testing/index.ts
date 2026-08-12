/**
 * Fixtures for a suite that exercises a store built on this kernel: a real SQLite engine off-device, a version atom
 * that recomputes on every read, the host services as spies, and the wrappers that pin a case to one build.
 */

export { createSqlJsConnection, initSqlJs } from './sqljs_connection';
export type { SqlJsCapabilities, SqlJsConnection } from './sqljs_connection';
export { createTestVersionAtom } from './version_atom';
export { installTestRuntime } from './runtime';
export type { TestRuntime } from './runtime';
export { itDev, itProd, describeDev, devWarnings } from './dev_mode';
