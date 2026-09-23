/**
 * The kernel's {@link SqliteConnection} over `react-native-nitro-sqlite`: it opens the database on device, applies the
 * pragmas a store depends on, narrows JS values to what the JSI bridge binds, and routes a native shred through the
 * sentinel the fork's C++ matches. Every failure here degrades rather than throws, so a store that cannot get
 * SQLite keeps running on an in-memory table.
 */

import { NitroSQLite, open, openSecondary } from 'react-native-nitro-sqlite';

import { PinnedConnection, reportStoreDegradation, ShredSpec, SqliteConnection } from '../index';
import type { SqliteRecovery } from '../define_sqlite_store';

/** Matched verbatim by `sqliteExecute` in our `react-native-nitro-sqlite` fork (`cpp/shred.cpp`). */
const NITRO_SHRED_SENTINEL = '-- nitro_shred_v1';

function toNativeParams(params?: ReadonlyArray<unknown>): Array<string | number | null> | undefined {
  if (!params) return undefined;
  return params.map((value) => {
    if (value == null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string' || typeof value === 'number') return value;
    return JSON.stringify(value);
  });
}

/** Every connection this module has open, with the handles to close it by: nitro addresses a handle by name, not by object. */
const openConnections = new Map<string, { conn: SqliteConnection; handles: ReadonlyArray<{ close(): void }> }>();

export function getOpenSqliteConnections(): Array<{ name: string; conn: SqliteConnection }> {
  return Array.from(openConnections, ([name, entry]) => ({ name, conn: entry.conn }));
}

/**
 * Closes a connection's handles and forgets it. Best effort per handle: a handle that will not close is one this
 * process cannot hand back either way, and the report that follows a failed bind is the one worth keeping.
 */
export function closeNitroConnection(name: string): void {
  const entry = openConnections.get(name);
  if (!entry) return;
  openConnections.delete(name);
  for (const handle of entry.handles) {
    try {
      handle.close();
    } catch {
      /* already gone, or never opened */
    }
  }
}

const PRAGMAS: ReadonlyArray<{ sql: string; cost: string }> = [
  { sql: 'PRAGMA journal_mode=WAL;', cost: 'DB stays on the slower default journal mode' },
  { sql: 'PRAGMA synchronous=NORMAL;', cost: 'writes fsync more often than they need to' },
  { sql: 'PRAGMA busy_timeout=5000;', cost: 'a contended write throws SQLITE_BUSY instead of waiting for the lock' },
  { sql: 'PRAGMA temp_store=MEMORY;', cost: "the ranker's temp tables can spill to a file instead of staying resident" },
  // Negative is KiB, and caps rather than reserves.
  { sql: 'PRAGMA cache_size=-8000;', cost: "the page cache stays at SQLite's 2MB default, so bulk ingests re-read index pages" },
];

function applyPragmas(conn: ReturnType<typeof open>, name: string): void {
  for (const pragma of PRAGMAS) {
    try {
      conn.execute(pragma.sql);
    } catch (error) {
      reportStoreDegradation({
        scope: `nitro_connection.pragma.${name}`,
        context: `failed to apply \`${pragma.sql}\` — ${pragma.cost}`,
        error,
        extra: { connection: name, pragma: pragma.sql },
      });
    }
  }
}

/**
 * Shred specs already serialized. A store hands the same spec object to every ingest of a partition variant, and the
 * spec describes the schema rather than the body, so serializing it per call re-encodes a constant.
 */
const serializedSpecs = new WeakMap<ShredSpec, string>();

function serializeSpec(spec: ShredSpec): string {
  const cached = serializedSpecs.get(spec);
  if (cached !== undefined) {
    // Caching on identity assumes a spec is never edited after its first ingest. Nothing freezes them, so in dev the
    // assumption is checked rather than trusted: silently shredding against a stale spec writes the wrong columns.
    if (__DEV__ && JSON.stringify(spec) !== cached) {
      throw new Error(`nitro_connection: shred spec for '${spec.table}' was mutated after it was first serialized`);
    }
    return cached;
  }
  const json = JSON.stringify(spec);
  serializedSpecs.set(spec, json);
  return json;
}

/**
 * A batch command's params are either one bind list or a list of them, and nitro decodes an empty array as the list of
 * lists: zero executions, so the statement is silently dropped. A statement with nothing to bind has to send none.
 */
const toBatchCommand = ([query, params]: readonly [string, ReadonlyArray<unknown>?]) => ({
  query,
  params: params?.length ? toNativeParams(params) : undefined,
});

function adaptHandle(conn: ReturnType<typeof open>): PinnedConnection {
  return {
    execute: (sql, params) => conn.execute(sql, toNativeParams(params)),
    executeBatch: (commands) => {
      conn.executeBatch(commands.map(toBatchCommand));
    },
    executeAsync: (sql, params) => conn.executeAsync(sql, toNativeParams(params)),
    executeBatchAsync: async (commands) => {
      await conn.executeBatchAsync(commands.map(toBatchCommand));
    },
    shredJsonArrayAsync: async (spec: ShredSpec, rawJson: string, scopeBinds: ReadonlyArray<string | number | null>): Promise<number> => {
      const params = toNativeParams([serializeSpec(spec), rawJson, ...scopeBinds]);
      const result = await conn.executeAsync(NITRO_SHRED_SENTINEL, params);
      const rowsAffected = (result as { rowsAffected?: number } | undefined)?.rowsAffected;
      return typeof rowsAffected === 'number' ? rowsAffected : 0;
    },
  };
}

/** A handle name nitro still holds is reported this way; the message is the only thing that distinguishes it. */
function isHandleInUse(error: unknown): boolean {
  return String((error as { message?: unknown })?.message ?? error).includes('is already in use');
}

/**
 * Opens `name`'s dedicated reader, reclaiming the handle if a previous JS runtime left it open.
 *
 * {@link closeNitroConnection} can only hand back handles this module's own map knows about, and that map lives in the
 * JS heap. An iOS CodePush reload replaces the JS runtime in the same native process, so the new runtime starts with an
 * empty map while nitro's registry still holds every handle the old one opened. The writer survives that, because
 * `open` addresses a database by name and re-registers it; a secondary handle's name is exclusive, so the reader is the
 * one that collides.
 *
 * Losing it is not the small thing it reads as. `readRows` falls back to the writer handle, so the ranker's multi
 * statement `TEMP` work starts interleaving with an ingest's savepoint on one connection, SQLite refuses the nested
 * transaction, and the first refusal degrades the whole store onto an in-memory table — the entire working set back
 * on the JS heap. So this tries hard: close the stale handle by name and retry, and failing that take a unique name,
 * which cannot collide with anything.
 */
function openReader(name: string): ReturnType<typeof openSecondary> | undefined {
  const preferred = `${name}:reader`;
  try {
    return openSecondary({ name, handle: preferred });
  } catch (error) {
    if (!isHandleInUse(error)) throw error;
  }

  // Addressed by name, which is how nitro identifies a connection — holding the original object is not required, and
  // after a reload there is no object to hold.
  try {
    NitroSQLite.native.close(preferred);
    return openSecondary({ name, handle: preferred });
  } catch {
    /* the stale handle would not close, or the retry lost the same race; fall through to a name of our own */
  }

  return openSecondary({ name, handle: `${preferred}:${Date.now().toString(36)}` });
}

export function openNitroConnection(name: string, opts?: { dedicatedReader?: boolean }): SqliteConnection {
  // Reopening a database this process already holds — a Fast Refresh re-running init, or a store rebound after a
  // schema change — has to hand the previous handles back first. Registering over them would leak them, and because a
  // secondary handle's name is exclusive, the reader is the one that would not come back.
  closeNitroConnection(name);

  const writer = open({ name });
  applyPragmas(writer, name);
  const handles: Array<{ close(): void }> = [writer];

  let reader: PinnedConnection | undefined;
  if (opts?.dedicatedReader) {
    try {
      const readHandle = openReader(name);
      if (readHandle) {
        applyPragmas(readHandle, `${name}:reader`);
        reader = adaptHandle(readHandle);
        handles.push(readHandle);
      }
    } catch (error) {
      reportStoreDegradation({
        scope: `nitro_connection.reader.${name}`,
        context:
          'failed to open the dedicated reader handle — reads fall back to the writer, where a read that needs a transaction can collide ' +
          'with an ingest and degrade the store onto an in-memory table',
        error,
        extra: { connection: name },
      });
    }
  }

  const adapted: SqliteConnection = { ...adaptHandle(writer), reader };
  openConnections.set(name, { conn: adapted, handles });
  openedDuringBind?.add(name);
  return adapted;
}

/**
 * Names opened by the bind currently running, tracked by what this attempt opened rather than by what was already
 * registered: a store re-initializing — a retry, or a Fast Refresh — opens a name that is *also* the one it held
 * before, and comparing registries would take that for a connection someone else owns and leave it open.
 */
let openedDuringBind: Set<string> | undefined;

/** Runs one bind attempt, and returns what it threw, having closed whatever the attempt had opened. */
function attemptBind(bind: () => void): unknown {
  const outer = openedDuringBind;
  const opened = new Set<string>();
  openedDuringBind = opened;
  try {
    bind();
    return undefined;
  } catch (error) {
    // A half-bound store would otherwise keep its handles for the life of the process, and a secondary handle's name is
    // exclusive: whatever opens next could not have its reader back, and would report a handle collision on top of the
    // failure that actually happened.
    for (const name of opened) closeNitroConnection(name);
    return error ?? new Error('bind failed');
  } finally {
    openedDuringBind = outer;
  }
}

/**
 * Deletes `name`'s database and the WAL files beside it, so the next open starts empty; a WAL left behind would replay
 * the old pages into the new file. Best effort per file: one that is not there is already what this wants.
 */
function discardNitroDatabase(name: string): void {
  closeNitroConnection(name);
  for (const file of [name, `${name}-wal`, `${name}-shm`]) {
    try {
      NitroSQLite.native.drop(file);
    } catch {
      /* not there, or not removable; the open that follows says which */
    }
  }
}

interface BindableStore {
  bindSqlite: (conn: SqliteConnection, recovery?: SqliteRecovery) => void;
  moveToSqlite: (conn: SqliteConnection, recovery?: SqliteRecovery) => void;
}

interface StoreBinding {
  label: string;
  dbName: string;
  store: BindableStore;
  opts?: { dedicatedReader?: boolean };
}

/** Stores running on an in-memory table because their database would not open or kept failing, by database name. */
const onHeap = new Map<string, StoreBinding>();
const retriesByDb = new Map<string, number>();
/** Each retry that fails again costs a full refetch of the store, so a database that never opens stops being retried. */
const MAX_RETRIES = 3;

function recoveryFor(binding: StoreBinding): SqliteRecovery {
  return {
    reopen: ({ discard }) => {
      if (discard) discardNitroDatabase(binding.dbName);
      return openNitroConnection(binding.dbName, binding.opts);
    },
    onFallback: () => onHeap.set(binding.dbName, binding),
  };
}

/**
 * Opens `dbName` and moves `store` onto it. A database that will not open or migrate is retried once from empty, since
 * it is only a cache and a damaged file is the likeliest reason; a store that still cannot bind stays on its in-memory
 * table until {@link retrySqliteStores}. Once bound, a failure mid-session reopens the database before giving up on it.
 */
export function bindSqliteStore(label: string, dbName: string, store: BindableStore, opts?: { dedicatedReader?: boolean }): void {
  const binding: StoreBinding = { label, dbName, store, opts };
  const bind = () => store.bindSqlite(openNitroConnection(dbName, opts), recoveryFor(binding));
  const firstError = attemptBind(bind);
  if (firstError === undefined) return;

  discardNitroDatabase(dbName);
  const secondError = attemptBind(bind);
  if (secondError === undefined) {
    reportStoreDegradation({
      scope: `nitro_connection.bind_fresh.${label}`,
      context: 'failed to bind SQLite, then bound after deleting the database — the store starts empty and refetches',
      error: firstError,
      extra: { label },
      severity: 'info',
    });
    return;
  }

  onHeap.set(dbName, binding);
  reportStoreDegradation({
    scope: `nitro_connection.bind.${label}`,
    context:
      'failed to bind SQLite, and again after deleting the database — the store runs on an in-memory table until a retry binds it',
    error: firstError,
    extra: { label, afterDeleting: String((secondError as { message?: unknown })?.message ?? secondError) },
  });
}

/**
 * Tries every store running on an in-memory table — one whose bind failed, or that gave up on SQLite mid-session — on
 * its database again. For the app to call on returning to the foreground: a launch in the background, before the
 * device's first unlock after a restart, is one where the database cannot be opened and later can.
 */
export function retrySqliteStores(): void {
  for (const [dbName, binding] of onHeap) {
    const retries = (retriesByDb.get(dbName) ?? 0) + 1;
    if (retries > MAX_RETRIES) continue;
    retriesByDb.set(dbName, retries);
    const error = attemptBind(() => binding.store.moveToSqlite(openNitroConnection(dbName, binding.opts), recoveryFor(binding)));
    if (error !== undefined) continue;
    onHeap.delete(dbName);
    reportStoreDegradation({
      scope: `nitro_connection.rebound.${binding.label}`,
      context: 'a store that was running on an in-memory table is back on SQLite, and refetches into it',
      extra: { label: binding.label, retries },
      severity: 'info',
    });
  }
}
