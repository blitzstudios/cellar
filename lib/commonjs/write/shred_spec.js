"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.evalShredElement = evalShredElement;
exports.evalShredSpec = evalShredSpec;
/**
 * The format of programs for the native JSON shredder in our `react-native-nitro-sqlite` fork, which turns a response
 * body into table rows in C++ without building JS objects. A program gives one op per column, reading dot-separated
 * paths from each element (`item.item_id`). `evalOp` here is the reference the C++ code matches, checked by a parity
 * test, so a new op has to be added on both sides.
 */

/** One piece of a `concat` column. */

/**
 * How the native shredder fills one column from an element, and the choices for a `ShredColumn`'s `op`. A column also
 * has a `js` builder, and its op must produce the same value, including for a missing field: `real` and `real0`
 * differ only in whether a missing value is null or 0.
 */

/**
 * One condition of the delete a native shred runs before inserting: rows where `column` equals `binds[bindIndex]`.
 * Together the conditions pick out the partition the response replaces.
 */

/** A native shred program for one table: `ops[i]` fills `columns[i]` for each element of the response. */

/**
 * A store's native shred programs, passed to `defineSqliteStore`. Use it for a response large enough that building JS
 * objects from it is most of the ingest's cost. When `variant` names no program in `specs`, the store builds rows
 * with its JS `parse` instead.
 */

function getPath(element, path) {
  let cur = element;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}
function isPresent(value) {
  return value != null;
}
function toConcatString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return String(value);
}
function toReal(value, absent) {
  if (value == null) return absent;
  const num = Number(value);
  return Number.isFinite(num) ? num : absent;
}
function coalesce(element, paths) {
  for (const path of paths) {
    const value = getPath(element, path);
    if (isPresent(value)) return value;
  }
  return undefined;
}
function evalOp(op, element, binds) {
  switch (op.op) {
    case 'bind':
      return binds[op.index] ?? null;
    case 'text':
      {
        const value = getPath(element, op.path);
        return typeof value === 'string' ? value : null;
      }
    case 'int':
      {
        const value = getPath(element, op.path);
        return typeof value === 'number' ? value : null;
      }
    case 'real':
      {
        const value = getPath(element, op.path);
        return toReal(value, null);
      }
    case 'boolInt':
      {
        const value = getPath(element, op.path);
        return value == null ? null : value ? 1 : 0;
      }
    case 'metaText':
      {
        const value = getPath(element, op.path);
        return value == null ? null : typeof value === 'string' ? value : String(value);
      }
    case 'real0':
      {
        const value = getPath(element, op.path);
        return toReal(value, 0);
      }
    case 'coalesceText':
      {
        const value = coalesce(element, op.paths);
        if (isPresent(value)) return typeof value === 'string' ? value : String(value);
        if (op.fallbackBindIndex != null) return binds[op.fallbackBindIndex] ?? null;
        return op.emptyDefault ? '' : null;
      }
    case 'concat':
      return op.parts.map(part => toConcatString(coalesce(element, part.paths))).join(op.sep);
    case 'rawJsonField':
      {
        const value = getPath(element, op.path);
        // Bytes differ from the native shredder, which slices the source document; both parse to the same value.
        return value == null ? null : JSON.stringify(value);
      }
    default:
      {
        const _exhaustive = op;
        return _exhaustive;
      }
  }
}
function passesGuard(spec, element) {
  if (!spec.whereGuard) return true;
  const value = coalesce(element, spec.whereGuard.paths);
  if (value == null) return false;
  return String(value) !== '';
}

/**
 * Runs a native shred program on one element in JS, returning the row the C++ shredder should produce, or `undefined`
 * when `whereGuard` skips it. A store's parity test compares this with the row its `js` builders produce.
 */
function evalShredElement(spec, element, binds) {
  if (!passesGuard(spec, element)) return undefined;
  const row = {};
  for (let index = 0; index < spec.columns.length; index += 1) {
    row[spec.columns[index]] = evalOp(spec.ops[index], element, binds);
  }
  return row;
}

/** Runs a native shred program on every element in JS. For an `objectValues` program, pass `Object.values(payload)`. */
function evalShredSpec(spec, elements, binds) {
  const out = [];
  for (const element of elements) {
    const row = evalShredElement(spec, element, binds);
    if (row) out.push(row);
  }
  return out;
}
//# sourceMappingURL=shred_spec.js.map