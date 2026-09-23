"use strict";

/** The row table held in JS `Map`s, which a store runs on on web and in every test. */

import { cacheKeyOf } from "../args_key.js";
import { createPresence, whereMapKey } from "./presence.js";
import { noteTableRead } from "./read_coverage.js";
import { columnNames } from "./types.js";
import { assertRowsMatchWhere, assertUnitColumn, comparator, matchesWhere } from "./query.js";
import { NO_CHANGES } from "./change_set.js";
import { changedUnits, rowSignature } from "./unit_diff.js";

/**
 * The {@link RowTable} a store gets where the platform has no SQLite: the web build, every test, and the stretch before
 * a mobile store's connection is bound. Its rows sit on the JS heap, so it answers a read exactly as SQLite would and
 * saves none of the memory the off-heap design is for.
 */
export function createMemoryRowTable(schema) {
  if (__DEV__) assertUnitColumn(schema);
  const hasPk = schema.primaryKey.length > 0;
  const {
    unit
  } = schema;
  const cols = columnNames(schema);
  const byPk = new Map();
  const rowsList = [];
  const presence = createPresence();
  const meta = new Map();
  const pkOf = row => cacheKeyOf(schema.primaryKey.map(column => String(row[column])));
  const allRows = () => hasPk ? byPk.values() : rowsList;
  const inUnits = changed => row => changed.has(String(row[unit]));
  function removeWhere(where, also) {
    if (hasPk) {
      for (const [key, row] of byPk) if (matchesWhere(row, where) && also(row)) byPk.delete(key);
    } else {
      for (let index = rowsList.length - 1; index >= 0; index -= 1) {
        if (matchesWhere(rowsList[index], where) && also(rowsList[index])) rowsList.splice(index, 1);
      }
    }
  }
  function insertRows(rows) {
    if (hasPk) {
      for (const row of rows) byPk.set(pkOf(row), row);
    } else {
      for (const row of rows) rowsList.push(row);
    }
  }

  /** Rewrites only the units whose rows differ, so an unchanged unit keeps the very row objects it held. */
  function overwriteWith(where, rows) {
    if (__DEV__) assertRowsMatchWhere(schema.table, where, rows);
    const before = [];
    for (const row of allRows()) if (matchesWhere(row, where)) before.push(row);
    const changed = changedUnits(before, rows, unit, cols);
    if (changed.size) {
      const changedRow = inUnits(changed);
      removeWhere(where, changedRow);
      insertRows(rows.filter(changedRow));
    }
    presence.afterDelete(where);
    return {
      changes: changed.size ? changed : NO_CHANGES,
      rows: rows.length
    };
  }
  return {
    primaryKey: schema.primaryKey,
    unit,
    init() {},
    async upsert(rows) {
      const changed = new Set();
      const moved = [];
      for (const row of rows) {
        const held = hasPk ? byPk.get(pkOf(row)) : undefined;
        if (held && rowSignature(held, cols) === rowSignature(row, cols)) continue;
        changed.add(String(row[unit]));
        moved.push(row);
      }
      insertRows(moved);
      if (moved.length) presence.afterInsert();
      return {
        changes: changed.size ? changed : NO_CHANGES,
        rows: rows.length
      };
    },
    overwrite(where, rows) {
      return overwriteWith(where, rows);
    },
    async shred(where, rawJson, parseRows) {
      return overwriteWith(where, parseRows(rawJson));
    },
    getOne(where) {
      noteTableRead();
      for (const row of allRows()) if (matchesWhere(row, where)) return row;
      return undefined;
    },
    find(where, opts) {
      noteTableRead();
      const out = [];
      for (const row of allRows()) if (matchesWhere(row, where)) out.push(row);
      if (opts?.orderBy) out.sort(comparator(opts.orderBy));
      return out;
    },
    findIn(where, column, values, _opts) {
      noteTableRead();
      if (!values.length) return [];
      const wanted = new Set(values);
      const out = [];
      for (const row of allRows()) {
        if (matchesWhere(row, where) && wanted.has(String(row[column]))) out.push(row);
      }
      return out;
    },
    has(where) {
      noteTableRead();
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
    unitsWhere(where) {
      noteTableRead();
      const seen = new Set();
      for (const row of allRows()) if (matchesWhere(row, where)) seen.add(String(row[unit]));
      return [...seen];
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