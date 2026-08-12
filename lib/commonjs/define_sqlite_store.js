"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineSqliteStore = defineSqliteStore;
var _once_guard = require("./diagnostics/once_guard.js");
var _telemetry = require("./diagnostics/telemetry.js");
var _version_atom = require("./reactivity/version_atom.js");
var _memory = require("./table/memory.js");
var _connection = require("./table/connection.js");
var _sqlite = require("./table/sqlite.js");
/** Declares a store that runs on SQLite where the platform provides it and on an in-memory row table elsewhere. */

/** SQLite-only accelerators: the optimizations a backend picks up where SQLite offers them. */

/**
 * What a store backend publishes: its reads, each becoming a `use`/`get` pair on the facade; its `push` group, for
 * rows a caller outside the store hands in, such as socket frames; and its lifecycle hooks.
 */

/**
 * What a store declares itself with: its name, its row schema, and the one function that builds a backend over
 * whichever row table the platform gives it. The two optional fields are the SQLite-only extras — a spec for shredding
 * an ingest in C++, and `sqliteCapabilities` for an accelerator that needs the live connection.
 */

/**
 * What a store's `store.ts` holds and re-exports: the version atom every read subscribes to, the accessors startup
 * binds the platform's backend through, the exit to the in-memory backend when SQLite fails, and the builder mobile's
 * `bindSqliteStore` hands an open connection to during startup.
 */

const NO_CAPS = {};
const lateBindGuard = (0, _once_guard.createOnceGuard)();

/**
 * How a store declares itself: one descriptor, and both platforms are wired. What comes back already runs on an
 * in-memory row table, so web and tests need nothing further; mobile calls `createSqliteBackend` with an open
 * connection during startup, and a SQLite failure mid-session drops the store back onto that in-memory table.
 */
function defineSqliteStore(config) {
  const version = (0, _version_atom.createVersionAtom)(`${config.name}_version`);
  const buildMemoryBackend = () => config.buildBackend((0, _memory.createMemoryRowTable)(config.schema), version, NO_CAPS);

  // The one slot every read resolves its backend through, holding the in-memory one until a platform binds its own.
  // Built on first read, so a platform that binds never builds it, and swapped before that read, so the accessor
  // hooks delegating to it stay rules-of-hooks safe.
  let active;
  let hasBeenRead = false;
  const getBackend = () => {
    hasBeenRead = true;
    return active ??= buildMemoryBackend();
  };
  const setBackend = backend => {
    if (__DEV__ && hasBeenRead && !lateBindGuard.seen('late_bind')) {
      // eslint-disable-next-line no-console
      console.warn('store_backend_slot.late_bind: a store backend was registered after something had already read from it. Backends bind once, during ' + 'startup, before the first read — reads taken against the previous backend are still holding its rows and versions, and nothing ' + 're-renders when it is replaced. Move the `bindOffHeapStore` call earlier in startup.');
    }
    active = backend;
  };
  let degraded = false;
  const resets = [];
  const degrade = reason => {
    if (degraded) return;
    degraded = true;
    (0, _telemetry.reportStoreDegradation)({
      scope: `${config.name}.runtime`,
      context: reason.context,
      error: reason.error,
      extra: reason.extra
    });
    queueMicrotask(() => {
      resets.forEach(reset => reset());
      // Assigned rather than set: the late-bind warning is about binding order during startup, and this swap is
      // neither late nor a bind.
      active = buildMemoryBackend();
      version.bumpAll();
    });
  };
  return {
    version,
    getBackend,
    setBackend,
    degrade,
    onDegrade: reset => {
      resets.push(reset);
    },
    createSqliteBackend: conn => {
      // Guarded before anything is built on it, so a failure below degrades the store.
      const guarded = (0, _connection.guardedConnection)(conn, (error, op) => degrade({
        context: `SQLite \`${op}\` failed mid-session; the store is now on its in-memory backend and will refetch`,
        error,
        extra: {
          store: config.name,
          table: config.schema.table,
          op
        }
      }));
      const backend = config.buildBackend((0, _sqlite.createSqliteRowTable)(config.schema, guarded, config.nativeShredSpec), version, config.sqliteCapabilities?.(guarded) ?? NO_CAPS);
      const forget = backend.lifecycle?.forget;
      if (forget) resets.push(forget);
      return backend;
    }
  };
}
//# sourceMappingURL=define_sqlite_store.js.map