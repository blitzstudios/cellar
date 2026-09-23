"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineSqliteStore = defineSqliteStore;
var _telemetry = require("./diagnostics/telemetry.js");
var _version_atom = require("./reactivity/version_atom.js");
var _memory = require("./table/memory.js");
var _connection = require("./table/connection.js");
var _sqlite = require("./table/sqlite.js");
/** Declares a store that runs on SQLite where the platform provides it and on an in-memory row table elsewhere. */

/** SQLite-only accelerators: the optimizations a store picks up where SQLite offers them. */

/**
 * What a store publishes: its reads, each becoming a `use`/`get` pair on the facade; its `push` group, for rows a
 * caller outside the store hands in, such as socket frames; and its lifecycle hooks.
 */

/**
 * What a store declares itself with: its name, its row schema, and `build`, which makes its surface over a row table.
 * The two optional fields are the SQLite-only extras — a spec for shredding an ingest in C++, and `sqliteCapabilities`
 * for an accelerator that needs the live connection.
 */

/** What a test takes a store over: a table of its own, and the version atom and capabilities it wants that to run with. */

/**
 * A declared store. `reads`, `push` and `lifecycle` are looked up on the running table at each access, so they follow
 * the store onto SQLite at startup and back off it if SQLite fails; hold the store, not a member taken off it.
 */

const NO_CAPS = {};

/**
 * A view of one group of the running surface, looked up at each access so that a bind or a degrade reaches every
 * caller, including one that took the group before it happened.
 */
function delegate(group, label) {
  const resolve = () => {
    const target = group();
    if (!target) throw new Error(`${label}: this store has no such group`);
    return target;
  };
  return new Proxy({}, {
    get: (_target, key) => Reflect.get(resolve(), key),
    has: (_target, key) => Reflect.has(resolve(), key),
    ownKeys: () => Reflect.ownKeys(resolve()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), key);
      // The proxy's own target holds nothing, so every property it reports has to be configurable.
      return descriptor && {
        ...descriptor,
        configurable: true
      };
    }
  });
}

/**
 * How a store declares itself: one descriptor, and both platforms are wired. What comes back already runs on an
 * in-memory row table, so web and tests need nothing further; mobile calls `bindSqlite` with an open connection during
 * startup, and a SQLite failure mid-session drops the store back onto an in-memory table.
 */
function defineSqliteStore(config) {
  const version = (0, _version_atom.createVersionAtom)(`${config.name}_version`);
  const buildInMemory = () => config.build((0, _memory.createMemoryRowTable)(config.schema), version, NO_CAPS);

  // Built on first read, so a platform that binds never builds it, and swapped before that read, so a hook that
  // resolves through it every render keeps resolving to the same thing.
  let running;
  let hasBeenRead = false;
  const current = () => {
    hasBeenRead = true;
    return running ??= buildInMemory();
  };
  let degraded = false;
  let resets = [];
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
      running = buildInMemory();
      version.bumpAll();
    });
  };
  const bindSqlite = conn => {
    // Guarded before anything is built on it, so a failure below degrades the store.
    const guarded = (0, _connection.guardedConnection)(conn, (error, op) => degrade({
      context: `SQLite \`${op}\` failed mid-session; the store is now on an in-memory table and will refetch`,
      error,
      extra: {
        store: config.name,
        table: config.schema.table,
        op
      }
    }), (error, op) => (0, _telemetry.reportStoreDegradation)({
      scope: `${config.name}.contention`,
      context: `SQLite \`${op}\` was refused because another statement held the connection — absorbed rather than degraded, but the ` + 'store is one connection short of where it should be, which usually means its dedicated reader never opened',
      error,
      extra: {
        store: config.name,
        table: config.schema.table,
        op
      }
    }));
    const onSqlite = config.build((0, _sqlite.createSqliteRowTable)(config.schema, guarded, config.nativeShredSpec), version, config.sqliteCapabilities?.(guarded) ?? NO_CAPS);
    const forget = onSqlite.lifecycle?.forget;
    if (forget) resets.push(forget);

    // Reported rather than warned: in a release build this is silent, and the symptom — a screen that is simply always
    // empty for some users — is one nobody would trace back to startup ordering.
    if (hasBeenRead) {
      (0, _telemetry.reportStoreDegradation)({
        scope: 'store.late_bind',
        context: 'a store was bound to SQLite after something had already read from it. A store binds once, during startup, before the ' + 'first read — reads taken before the bind are still holding the in-memory rows and versions, and nothing re-renders when ' + 'it moves. Move the `bindOffHeapStore` call earlier in startup.'
      });
    }
    running = onSqlite;
  };
  return {
    reads: delegate(() => current().reads, `${config.name}.reads`),
    push: delegate(() => current().push, `${config.name}.push`),
    lifecycle: delegate(() => current().lifecycle, `${config.name}.lifecycle`),
    bindSqlite,
    degrade,
    testing: {
      over: (table = (0, _memory.createMemoryRowTable)(config.schema), options = {}) => config.build(table, options.version ?? version, options.caps ?? NO_CAPS),
      swap: surface => {
        running = surface;
      },
      reset: () => {
        running = undefined;
        hasBeenRead = false;
        degraded = false;
        resets = [];
      }
    }
  };
}
//# sourceMappingURL=define_sqlite_store.js.map