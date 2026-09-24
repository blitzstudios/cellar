"use strict";

/** Declares a store that runs on SQLite everywhere: the device's on mobile, and sql.js on web and in tests. */

import { reportStoreDegradation } from "./diagnostics/telemetry.js";
import { createVersionAtom } from "./reactivity/version_atom.js";
import { guardedConnection } from "./table/connection.js";
import { createSqliteRowTable } from "./table/sqlite.js";

/** Things a store builds from its database connection besides the row table, such as a ranker that runs its own SQL. */

/** What a store's `build` returns: its reads, its push functions, and its lifecycle functions. */

/** Everything {@link defineSqliteStore} needs to declare a store: its name, its table, and how to build it. */

/** How a store gets a database back when SQLite fails under it. */

/** Options for {@link SqliteStore.bindSqlite}. */

/**
 * A store declared with {@link defineSqliteStore}. `reads`, `push` and `lifecycle` are looked up on the database the
 * store is currently running on at each access, so they follow the store when it moves; keep the store, not a member
 * taken off it.
 */

/** Answers every statement with no rows: what an unbound store runs on, so each read gives back its declared `empty`. */
const NULL_CONNECTION = {
  execute: () => ({
    rows: {
      _array: []
    }
  })
};

/**
 * Reopens a store gets per session before it moves to its fallback. A database that fails again straight after a
 * reopen is failing for a reason a reopen does not fix, and each attempt costs a refetch of every partition.
 */
const MAX_REOPENS = 2;

/** An error that means the file itself is unusable, so reopening it would only fail the same way. */
const CORRUPTION = /SQLITE_CORRUPT|SQLITE_NOTADB|malformed|not a database/i;
const messageOf = error => String(error?.message ?? error);

/**
 * A view of one group of the running surface, looked up at each access so that a move reaches every caller, including
 * one that took the group before it happened.
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
 * Declares a store: a row table plus the reads built over it, run on whatever SQLite database it is bound to. Until a
 * bind, every read returns its declared `empty`. On mobile, a SQLite failure mid-session reopens the database, then
 * moves the store to an in-memory database, and only then leaves it unbound.
 */
export function defineSqliteStore(config) {
  const version = createVersionAtom(`${config.name}_version`);
  const extra = more => ({
    store: config.name,
    table: config.schema.table,
    ...more
  });
  const capabilitiesOf = conn => config.capabilities ? config.capabilities(conn) : {};
  let running;
  let hasBeenRead = false;
  let reopens = 0;
  // What each surface the store has run on primed, so leaving it can have the next one fetch for itself.
  let resets = [];
  const buildOver = (conn, temporary, atom = version) => {
    const table = createSqliteRowTable(config.schema, conn, config.nativeShredSpec, {
      temporary
    });
    return {
      surface: config.build(table, atom, capabilitiesOf(conn)),
      table
    };
  };
  const install = surface => {
    const forget = surface.lifecycle?.forget;
    if (forget) resets.push(forget);
    running = surface;
    return surface;
  };

  /** Forgets what the running surface fetched, runs the store on `surface`, and has every reader read from it. */
  const replaceRunning = surface => {
    const previous = resets;
    resets = [];
    previous.forEach(reset => reset());
    install(surface);
    version.bumpAll();
  };

  // Built on first read, so a platform that binds first never builds it.
  const current = () => {
    hasBeenRead = true;
    return running ?? install(buildOver(NULL_CONNECTION, false).surface);
  };

  /** The store over SQLite on `conn`, guarded so that a failure on it reopens the database or moves the store off it. */
  const buildGuarded = (conn, options) => {
    const guarded = guardedConnection(conn, (error, op) => onSqliteFailure(error, op, options), (error, op) => reportStoreDegradation({
      scope: `${config.name}.contention`,
      context: `SQLite \`${op}\` was refused because another statement held the connection — absorbed, but the store is one ` + 'connection short of where it should be, which usually means its dedicated reader never opened',
      error,
      extra: extra({
        op
      })
    }));
    return buildOver(guarded, !!options.temporary).surface;
  };

  /** The last resort: nothing to read from, reported, and handed to the binding so a later retry can bring the store back. */
  const leaveUnbound = (context, error, options, more) => {
    reportStoreDegradation({
      scope: `${config.name}.unbound`,
      context,
      error,
      extra: extra(more)
    });
    replaceRunning(buildOver(NULL_CONNECTION, false).surface);
    options.recovery?.onLeftFile?.();
  };

  /** Moves the store to its in-memory fallback, or leaves it unbound when there is none. */
  const moveToFallback = (error, op, options) => {
    const fallback = options.recovery?.fallback;
    if (!fallback) {
      leaveUnbound(`SQLite \`${op}\` failed mid-session and the store has no fallback; its reads are empty until a retry binds it`, error, options, {
        op
      });
      return;
    }
    try {
      const fallbackOptions = {
        temporary: true,
        recovery: {
          reopen: options.recovery.reopen,
          onLeftFile: options.recovery.onLeftFile
        }
      };
      replaceRunning(buildGuarded(fallback(), fallbackOptions));
      options.recovery?.onLeftFile?.();
      reportStoreDegradation({
        scope: `${config.name}.in_memory`,
        context: `SQLite \`${op}\` kept failing on the database file; the store runs on an in-memory database and refetches into it`,
        error,
        extra: extra({
          op
        })
      });
    } catch (fallbackError) {
      leaveUnbound('the in-memory fallback could not be opened either; the store reads empty until a retry binds it', fallbackError, options, {
        op,
        firstError: messageOf(error)
      });
    }
  };

  /**
   * A statement failed, and the connection it ran on answers nothing from here. The store reopens the database — or,
   * when the file is what failed, deletes it and starts empty — and refetches into it; after that, it moves to its
   * in-memory fallback. Deferred, so the failing statement's caller unwinds first.
   */
  const onSqliteFailure = (error, op, options) => {
    queueMicrotask(() => {
      const recovery = options.recovery;
      if (!recovery || options.temporary || reopens >= MAX_REOPENS) {
        moveToFallback(error, op, options);
        return;
      }
      reopens += 1;
      const discard = CORRUPTION.test(messageOf(error));
      try {
        const conn = recovery.reopen({
          discard
        });
        // A write that failed may have left rows short of what their ETag vouches for, so each partition's next fetch
        // brings a whole body rather than a 304.
        if (!discard && config.schema.meta) {
          try {
            conn.execute(`DELETE FROM ${config.schema.meta.table};`);
          } catch {
            /* a database with no meta table yet has no ETags to clear */
          }
        }
        replaceRunning(buildGuarded(conn, options));
        reportStoreDegradation({
          scope: `${config.name}.reopened`,
          context: `SQLite \`${op}\` failed mid-session; the store reopened its database${discard ? ', deleting it first,' : ''} and will refetch into it`,
          error,
          extra: extra({
            op,
            discard,
            reopens
          }),
          severity: 'info'
        });
      } catch (reopenError) {
        moveToFallback(reopenError, op, options);
      }
    });
  };
  const bindSqlite = (conn, options = {}) => {
    const surface = buildGuarded(conn, options);
    // Reported rather than warned: a startup bind that lands after a read means startup ordering moved, and that
    // read's first paint was empty.
    if (options.startup && hasBeenRead) {
      reportStoreDegradation({
        scope: 'store.late_bind',
        context: 'a store was bound at startup after something had already read from it, so that read painted empty first. Move the ' + '`bindOffHeapStore` call earlier in startup.'
      });
    }
    if (!options.temporary) reopens = 0;
    replaceRunning(surface);
  };
  return {
    reads: delegate(() => current().reads, `${config.name}.reads`),
    push: delegate(() => current().push, `${config.name}.push`),
    lifecycle: delegate(() => current().lifecycle, `${config.name}.lifecycle`),
    bindSqlite,
    testing: {
      over: (conn, options = {}) => buildOver(conn, false, options.version),
      swap: surface => {
        running = surface;
      },
      reset: () => {
        running = undefined;
        hasBeenRead = false;
        reopens = 0;
        resets = [];
      }
    }
  };
}
//# sourceMappingURL=define_sqlite_store.js.map