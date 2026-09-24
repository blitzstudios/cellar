/**
 * The format of programs for the native JSON shredder in our `react-native-nitro-sqlite` fork, which turns a response
 * body into table rows in C++ without building JS objects. A program gives one op per column, reading dot-separated
 * paths from each element (`item.item_id`). `evalOp` here is the reference the C++ code matches, checked by a parity
 * test, so a new op has to be added on both sides.
 */
import { SqlValue } from '../table/types';
/** One piece of a `concat` column. */
export interface ConcatPart {
    /** Paths to try in order; the first with a value supplies the piece's text, or `''` if none has one. */
    paths: string[];
}
/**
 * How the native shredder fills one column from an element, and the choices for a `ShredColumn`'s `op`. A column also
 * has a `js` builder, and its op must produce the same value, including for a missing field: `real` and `real0`
 * differ only in whether a missing value is null or 0.
 */
export type ShredOp = {
    /** The value at `binds[index]`, the same for every row, such as the partition's week. */
    op: 'bind';
    /** Which value in `binds`. */
    index: number;
} | {
    /** The string at `path`; null if missing or not a string. */
    op: 'text';
    /** A dot-separated path from the element, such as `item.item_id`. */
    path: string;
} | {
    /** The number at `path` as is; null if missing or not a number. */
    op: 'int';
    /** A dot-separated path from the element, such as `item.item_id`. */
    path: string;
} | {
    /**
     * The value at `path` converted to a number, so `"12.5"` becomes 12.5; null if missing or not a finite number.
     */
    op: 'real';
    /** A dot-separated path from the element, such as `item.item_id`. */
    path: string;
} | {
    /** 1 if the value at `path` is truthy, 0 if falsy; null if missing. */
    op: 'boolInt';
    /** A dot-separated path from the element, such as `item.item_id`. */
    path: string;
} | {
    /** The value at `path` as a string, converting a number or boolean; null if missing. */
    op: 'metaText';
    /** A dot-separated path from the element, such as `item.item_id`. */
    path: string;
} | {
    /** Like `real`, but 0 where `real` gives null. */
    op: 'real0';
    /** A dot-separated path from the element, such as `item.item_id`. */
    path: string;
} | {
    /** The first of `paths` with a value, as a string. */
    op: 'coalesceText';
    /** Paths to try in order. */
    paths: string[];
    /** If none has a value, use `''` instead of null. */
    emptyDefault?: boolean;
    /** If none has a value, use `binds[fallbackBindIndex]`; takes precedence over `emptyDefault`. */
    fallbackBindIndex?: number;
} | {
    /** The text of each part joined with `sep`, such as `player_id` and `week` joined into one id. */
    op: 'concat';
    /** The pieces, in order. */
    parts: ConcatPart[];
    /** The text between pieces. */
    sep: string;
} | {
    /** The value at `path` as JSON text; null if missing. */
    op: 'rawJsonField';
    /** A dot-separated path from the element, such as `item.item_id`. */
    path: string;
};
/**
 * One condition of the delete a native shred runs before inserting: rows where `column` equals `binds[bindIndex]`.
 * Together the conditions pick out the partition the response replaces.
 */
export interface ShredDeleteClause {
    /** The column to match. */
    column: string;
    /** Which value from `binds` it must equal. */
    bindIndex: number;
}
/** A native shred program for one table: `ops[i]` fills `columns[i]` for each element of the response. */
export interface ShredSpec {
    /** The program format's version. */
    version: 1;
    /** The table to write. */
    table: string;
    /** The insert statement's verb; `INSERT OR REPLACE` for a table where a row can be sent twice. */
    insertVerb: 'INSERT OR REPLACE' | 'INSERT';
    /** The columns to fill, in insert order. */
    columns: string[];
    /** How each column is filled, one per entry in `columns`. */
    ops: ShredOp[];
    /**
     * Where the elements are: the response is an array of them (`array`, the default), or an object whose values they are
     * (`objectValues`).
     */
    source?: 'array' | 'objectValues';
    /** The conditions of the delete run before inserting, which pick out the partition being replaced. */
    deleteWhere: ShredDeleteClause[];
    /** Skips an element when none of `paths` has a non-empty value. */
    whereGuard?: {
        /** The paths to check, in order. */
        paths: string[];
    };
}
/**
 * A store's native shred programs, passed to `defineSqliteStore`. Use it for a response large enough that building JS
 * objects from it is most of the ingest's cost. When `variant` names no program in `specs`, the store builds rows
 * with its JS `parse` instead.
 */
export interface NativeShredSpec {
    /** The programs, by variant name. */
    specs: Readonly<Record<string, ShredSpec>>;
    /** Picks the program for a partition, given its key's columns. */
    variant: (where: Readonly<Record<string, SqlValue>>) => string;
    /**
     * The values a program's `bind` ops and `deleteWhere` conditions refer to by index, for a partition given its key's
     * columns.
     */
    binds: (where: Readonly<Record<string, SqlValue>>) => SqlValue[];
}
/**
 * Runs a native shred program on one element in JS, returning the row the C++ shredder should produce, or `undefined`
 * when `whereGuard` skips it. A store's parity test compares this with the row its `js` builders produce.
 */
export declare function evalShredElement(spec: ShredSpec, element: unknown, binds: readonly SqlValue[]): Record<string, SqlValue> | undefined;
/** Runs a native shred program on every element in JS. For an `objectValues` program, pass `Object.values(payload)`. */
export declare function evalShredSpec(spec: ShredSpec, elements: readonly unknown[], binds: readonly SqlValue[]): Record<string, SqlValue>[];
//# sourceMappingURL=shred_spec.d.ts.map