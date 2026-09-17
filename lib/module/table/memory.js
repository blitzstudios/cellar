"use strict";

/** The row table held in JS `Map`s, which is the backend on web and in every test. */

import { cacheKey } from "../args_key.js";
import { createPresence, whereMapKey } from "./presence.js";
import { assertRowsMatchWhere, comparator, digestColumns, digestRow, matchesWhere } from "./query.js";

/**
 * The {@link RowTable} a store gets where the platform has no SQLite: the web build, every test, and the stretch before
 * a mobile store's connection is bound. Its rows sit on the JS heap, so it answers a read exactly as SQLite would and
 * saves none of the memory the off-heap design is for.
 */
export function createMemoryRowTable(schema) {
  const hasPk = schema.primaryKey.length > 0;
  const byPk = new Map();
  const rowsList = [];
  const presence = createPresence();
  const meta = new Map();
  const digestCols = digestColumns(schema);
  const pkOf = row => cacheKey(...schema.primaryKey.map(column => String(row[column])));
  const allRows = () => hasPk ? byPk.values() : rowsList;
  function removeWhere(where) {
    if (hasPk) {
      for (const [key, row] of byPk) if (matchesWhere(row, where)) byPk.delete(key);
    } else {
      for (let index = rowsList.length - 1; index >= 0; index -= 1) if (matchesWhere(rowsList[index], where)) rowsList.splice(index, 1);
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
    if (__DEV__) assertRowsMatchWhere(schema.table, where, rows);
    removeWhere(where);
    insertRows(rows);
    presence.afterDelete(where);
    return rows.length;
  }
  return {
    primaryKey: schema.primaryKey,
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
      for (const row of allRows()) if (matchesWhere(row, where)) return row;
      return undefined;
    },
    find(where, opts) {
      const out = [];
      for (const row of allRows()) if (matchesWhere(row, where)) out.push(row);
      if (opts?.orderBy) out.sort(comparator(opts.orderBy));
      return out;
    },
    findIn(where, column, values, _opts) {
      if (!values.length) return [];
      const wanted = new Set(values);
      const out = [];
      for (const row of allRows()) {
        if (matchesWhere(row, where) && wanted.has(String(row[column]))) out.push(row);
      }
      return out;
    },
    has(where) {
      const cached = presence.get(where);
      if (cached !== undefined) return cached;
      let found = false;
      for (const row of allRows()) {
        if (matchesWhere(row, where)) {
          found = true;
          break;
        }
      }
      presence.observe(where, found);
      return found;
    },
    digests(where, column, values) {
      const wanted = values && new Set(values);
      const out = new Map();
      if (wanted && !wanted.size) return out;
      for (const row of allRows()) {
        const id = String(row[column]);
        if (matchesWhere(row, where) && (!wanted || wanted.has(id))) out.set(id, digestRow(row, digestCols));
      }
      return out;
    },
    getMeta(where) {
      return meta.get(whereMapKey(where));
    },
    setMeta(where, value) {
      if (value === undefined) meta.delete(whereMapKey(where));else meta.set(whereMapKey(where), value);
    }
  };
}
//# sourceMappingURL=memory.js.map