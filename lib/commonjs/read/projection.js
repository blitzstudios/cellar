"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createRowProjection = createRowProjection;
exports.rowVmMemo = rowVmMemo;
var _caches = require("../caches.js");
var _once_guard = require("../diagnostics/once_guard.js");
var _query = require("../table/query.js");
/**
 * A view model per row, rebuilt only where the row behind it moved.
 *
 * The problem this exists for. A partition's version bump invalidates every value derived from it, and rows come back
 * from SQLite as fresh objects, so a read that rebuilds its view models hands its subscribers new references and
 * repaints all of them — whether or not anything they show actually changed. On the heap that never happened: the
 * response object was shared, so an unchanged entry kept its identity for free.
 *
 * A projection buys that back. It digests the rows instead of reading them, rebuilds only the ones whose content
 * moved, and keeps the previous reference for the rest, which is what lets the shallow-equal comparison above it bail
 * those subscribers out. A store declares one per view-model shape and every read of that shape shares it, so the
 * same row is built once however many reads ask for it.
 */

/** What a store declares: how one row becomes a view model, and how many of them to hold. */

/** A declared projection, as the reads of a store consume it. Every method hands back reference-stable view models. */

const thrashWarned = (0, _once_guard.createOnceGuard)();

/** The memo a projection holds its view models in: one per row, revalidated against that row's digest. */

/** The declaration a projection's memo is built from, so the store accounts for it with every other memo it holds. */
function rowVmMemo(max) {
  return (0, _caches.bySource)()({
    max,
    by: ['row']
  });
}

/**
 * What a projection needs from the store around it: the rows, how a key addresses them, and the memo its view models
 * live in — declared through the store's own `memos` block, so they are accounted for with the rest rather than off
 * to one side.
 */

function createRowProjection(ctx, def) {
  const {
    store,
    table,
    filter,
    memo
  } = ctx;

  /**
   * Worked out from the first key rather than at declaration, since the partition's filter is a function of one.
   * Cached because it cannot differ between keys of the same store: `where` names the same columns every time.
   */
  let idColumn = def.by;
  const identity = key => {
    if (idColumn) return idColumn;
    const fixed = new Set(Object.keys(filter(key)));
    const rest = table.primaryKey.filter(column => !fixed.has(column));
    if (rest.length !== 1) {
      throw new Error(`${store}_store: the '${def.name}' projection cannot tell what identifies a row. Its primary key is ` + `(${table.primaryKey.join(', ') || 'none'}) and the partition fixes (${[...fixed].join(', ') || 'nothing'}), ` + `which leaves ${rest.length ? `(${rest.join(', ')})` : 'no column'} rather than exactly one. Name it with \`by\`.`);
    }
    [idColumn] = rest;
    return idColumn;
  };
  const warnOnThrash = ids => {
    if (!__DEV__ || ids <= def.max || thrashWarned.seen(store, def.name)) return;
    // eslint-disable-next-line no-console
    console.warn(`[${store}_store] the '${def.name}' projection was asked for ${ids} rows but holds ${def.max}, so this read ` + 'evicts what it just built and rebuilds every view model on every bump. Raise `max` past the largest read, ' + `or read a narrower slice.${def.advice ? ` ${def.advice}` : ''}`);
  };

  /**
   * The heart of it. `peek` answers for rows already held at this version; the digests say which of the rest actually
   * moved; only those are read. `holds` is a prediction — an entry can be evicted between the question and the `put` —
   * so a row that misses after all is read on its own rather than coming back absent, which would silently drop it.
   */
  function resolve(key, scope, wanted) {
    const column = identity(key);
    const at = memo.for(key);
    const out = new Map();

    // With no id list in hand, the digests are what name the members, so they are read before anything is peeked.
    const digests = wanted === undefined ? table.digests(scope, column) : undefined;
    const ids = wanted ?? [...digests.keys()];
    warnOnThrash(ids.length);
    let misses;
    for (const id of ids) {
      const hit = at.peek(id);
      if (hit) out.set(id, hit.value);else (misses ??= []).push(id);
    }
    if (!misses) return out;
    const moved = digests ?? table.digests(scope, column, misses);
    const movers = misses.filter(id => !at.holds(id, moved.get(id) ?? _query.NO_ROW_DIGEST));
    const covered = movers.length === misses.length ? undefined : new Set(movers);
    let rows;
    const rowFor = id => {
      if (covered && !covered.has(id)) return table.getOne({
        ...scope,
        [column]: id
      });
      if (!rows) {
        rows = new Map();
        for (const row of table.findIn(scope, column, movers)) rows.set(String(row[column]), row);
      }
      return rows.get(id);
    };
    for (const id of misses) {
      const digest = moved.get(id) ?? _query.NO_ROW_DIGEST;
      out.set(id, at.put(id, digest, () => {
        if (digest === _query.NO_ROW_DIGEST) return undefined;
        const row = rowFor(id);
        return row ? def.of(row) : undefined;
      }));
    }
    return out;
  }
  const listed = (resolved, order) => {
    const out = [];
    for (const id of order) {
      const vm = resolved.get(id);
      if (vm !== undefined) out.push(vm);
    }
    return out;
  };
  const scopeFor = (key, extra) => extra ? {
    ...filter(key),
    ...extra
  } : filter(key);
  const overFilter = (key, extra) => {
    const resolved = resolve(key, scopeFor(key, extra), undefined);
    return listed(resolved, resolved.keys());
  };
  return {
    one: (key, id) => resolve(key, filter(key), [id]).get(id),
    byIds: (key, ids) => ids.length ? listed(resolve(key, filter(key), ids), ids) : [],
    mapByIds: (key, ids) => {
      const out = {};
      if (!ids.length) return out;
      const resolved = resolve(key, filter(key), ids);
      for (const id of ids) {
        const vm = resolved.get(id);
        if (vm !== undefined) out[id] = vm;
      }
      return out;
    },
    where: (key, extra) => overFilter(key, extra),
    all: key => overFilter(key)
  };
}
//# sourceMappingURL=projection.js.map