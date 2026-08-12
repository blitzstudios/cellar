"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createMemoryRowTable = createMemoryRowTable;
var _args_key = require("../args_key.js");
var _presence = require("./presence.js");
var _query = require("./query.js");
/** The row table held in JS `Map`s, which is the backend on web and in every test. */

/**
 * The {@link RowTable} a store gets where the platform has no SQLite: the web build, every test, and the stretch before
 * a mobile store's connection is bound. Its rows sit on the JS heap, so it answers a read exactly as SQLite would and
 * saves none of the memory the off-heap design is for.
 */
function createMemoryRowTable(schema) {
  const hasPk = schema.primaryKey.length > 0;
  const byPk = new Map();
  const rowsList = [];
  const presence = (0, _presence.createPresence)();
  const meta = new Map();
  const pkOf = row => (0, _args_key.cacheKey)(...schema.primaryKey.map(column => String(row[column])));
  const allRows = () => hasPk ? byPk.values() : rowsList;
  function removeWhere(where) {
    if (hasPk) {
      for (const [key, row] of byPk) if ((0, _query.matchesWhere)(row, where)) byPk.delete(key);
    } else {
      for (let index = rowsList.length - 1; index >= 0; index -= 1) if ((0, _query.matchesWhere)(rowsList[index], where)) rowsList.splice(index, 1);
    }
  }
  function insertRows(rows) {
    if (hasPk) {
      for (const row of rows) byPk.set(pkOf(row), row);
    } else {
      for (const row of rows) rowsList.push(row);
    }
  }
  function overwriteWith(where, rows) {
    if (__DEV__) (0, _query.assertRowsMatchWhere)(schema.table, where, rows);
    removeWhere(where);
    insertRows(rows);
    presence.afterDelete(where);
    return rows.length;
  }
  return {
    init() {},
    async upsert(rows) {
      insertRows(rows);
      presence.afterInsert();
      return rows.length;
    },
    overwrite(where, rows) {
      return overwriteWith(where, rows);
    },
    async shred(where, rawJson, parseRows) {
      return overwriteWith(where, parseRows(rawJson));
    },
    getOne(where) {
      for (const row of allRows()) if ((0, _query.matchesWhere)(row, where)) return row;
      return undefined;
    },
    find(where, opts) {
      const out = [];
      for (const row of allRows()) if ((0, _query.matchesWhere)(row, where)) out.push(row);
      if (opts?.orderBy) out.sort((0, _query.comparator)(opts.orderBy));
      return out;
    },
    findIn(where, column, values, _opts) {
      if (!values.length) return [];
      const wanted = new Set(values);
      const out = [];
      for (const row of allRows()) {
        if ((0, _query.matchesWhere)(row, where) && wanted.has(String(row[column]))) out.push(row);
      }
      return out;
    },
    has(where) {
      const cached = presence.get(where);
      if (cached !== undefined) return cached;
      let found = false;
      for (const row of allRows()) {
        if ((0, _query.matchesWhere)(row, where)) {
          found = true;
          break;
        }
      }
      presence.observe(where, found);
      return found;
    },
    getMeta(where) {
      return meta.get((0, _presence.whereMapKey)(where));
    },
    setMeta(where, value) {
      if (value === undefined) meta.delete((0, _presence.whereMapKey)(where));else meta.set((0, _presence.whereMapKey)(where), value);
    }
  };
}
//# sourceMappingURL=memory.js.map