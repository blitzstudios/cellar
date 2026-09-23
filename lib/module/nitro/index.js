"use strict";

/**
 * The on-device half of the kernel: opening a SQLite database through `react-native-nitro-sqlite` and binding a
 * store to it. Kept behind its own entry point so the core stays runnable off-device.
 */

export { openNitroConnection, getOpenSqliteConnections, bindSqliteStore } from "./nitro_connection.js";
//# sourceMappingURL=index.js.map