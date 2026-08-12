"use strict";

/**
 * The on-device half of the kernel: opening a SQLite database through `react-native-nitro-sqlite` and handing the
 * connection to a store's backend. Kept behind its own entry point so the core stays runnable off-device.
 */

export { openNitroConnection, getOpenSqliteConnections, bindSqliteBackend, bindSqliteStore } from "./nitro_connection.js";
//# sourceMappingURL=index.js.map