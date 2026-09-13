/**
 * The wire protocol for the native (simdjson) shredder in the `react-native-nitro-sqlite` fork: per-column ops over
 * dot-delimited paths rooted at the element (`item.item_id`). `evalOp` is the reference implementation the C++
 * side mirrors, pinned by a parity test, so a new op must land on both sides.
 */
import { SqlValue } from '../table/types';
/** One segment of a `concat` column, and the paths to try for it: the first present one supplies the segment's text. */
export interface ConcatPart {
    paths: string[];
}
/**
 * The closed set of extractions a column can be filled by, and what a `ShredColumn`'s `op` is chosen from. Each has a
 * `js` twin in the same column declaration, so pick the op that matches what the JS builder does with an absent field
 * — `real` and `real0` differ only in whether missing reads as null or as zero.
 */
export type ShredOp = {
    op: 'bind';
    index: number;
} | {
    op: 'text';
    path: string;
} | {
    op: 'int';
    path: string;
} | {
    op: 'real';
    path: string;
} | {
    op: 'boolInt';
    path: string;
} | {
    op: 'metaText';
    path: string;
} | {
    op: 'real0';
    path: string;
} | {
    op: 'coalesceText';
    paths: string[];
    emptyDefault?: boolean;
    fallbackBindIndex?: number;
} | {
    op: 'concat';
    parts: ConcatPart[];
    sep: string;
} | {
    op: 'rawJsonField';
    path: string;
};
/**
 * One column of the `WHERE` a shred deletes by before it inserts, matched to a value from `binds`. Together they name
 * the partition the incoming body replaces, which is how a native shred stays a whole-partition swap in one statement.
 */
export interface ShredDeleteClause {
    column: string;
    /** Index into `binds`. */
    bindIndex: number;
}
/** One table's shred program: `columns[i]` is produced by `ops[i]`, in the insert's bind order. */
export interface ShredSpec {
    version: 1;
    table: string;
    insertVerb: 'INSERT OR REPLACE' | 'INSERT';
    columns: string[];
    ops: ShredOp[];
    source?: 'array' | 'objectValues';
    deleteWhere: ShredDeleteClause[];
    /** Skips an element when the coalesce over these paths is null or empty. */
    whereGuard?: {
        paths: string[];
    };
}
/**
 * A store's native shred as `defineSqliteStore` takes it: every program the store can shred through, keyed by variant,
 * plus the partition values one binds. Declare it when a payload is big enough that turning it into JS objects is the
 * cost of the ingest; a `variant` naming no spec in the map falls back to the store's JS `parse` rather than failing.
 */
export interface NativeShredSpec {
    specs: Readonly<Record<string, ShredSpec>>;
    variant: (where: Readonly<Record<string, SqlValue>>) => string;
    /** Index-aligned with the spec's `bind` ops and `deleteWhere` entries. */
    binds: (where: Readonly<Record<string, SqlValue>>) => SqlValue[];
}
/**
 * One payload element through a spec in JS: the row the C++ shredder is expected to produce for it, and what a store's
 * parity test compares against the same element through its `js` builders. `undefined` is the spec's `whereGuard`
 * rejecting the element, which is the native pass skipping it.
 */
export declare function evalShredElement(spec: ShredSpec, element: unknown, binds: readonly SqlValue[]): Record<string, SqlValue> | undefined;
/** Runs a spec over every element; for a `source: 'objectValues'` spec the caller passes `Object.values(payload)`. */
export declare function evalShredSpec(spec: ShredSpec, elements: readonly unknown[], binds: readonly SqlValue[]): Record<string, SqlValue>[];
//# sourceMappingURL=shred_spec.d.ts.map