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
import { BoundSourceMemo, Memo, MemoDeclaration } from '../caches';
import { RowShape, RowTable } from '../table/types';
/** What a store declares: how one row becomes a view model, and how many of them to hold. */
export interface RowProjectionDef<Row extends RowShape, Vm> {
    /** Names this projection in a diagnostic, alongside the store — `player.card`. */
    name: string;
    /** Bounds the view models held. A read asking for more rows than this can never answer from the memo. */
    max: number;
    /** The only app-specific part. `undefined` for a row that does not make a view model. */
    of: (row: Row) => Vm | undefined;
    /**
     * The column identifying a row within one partition. Derived from the table's primary key, less whatever the
     * partition's filter fixes; name it only where that does not come out to exactly one column.
     */
    by?: keyof Row & string;
    /**
     * Appended to the warning a read too large for `max` raises, for a store whose answer is not "raise the bound" —
     * a view-model shape meant for one row at a time says to read the lean shape instead.
     */
    advice?: string;
}
/** A declared projection, as the reads of a store consume it. Every method hands back reference-stable view models. */
export interface RowProjection<Key, Row extends RowShape, Vm> {
    /** The view model for one row, or `undefined` where the partition holds no such row. */
    one(key: Key, id: string): Vm | undefined;
    /** In the order `ids` names them. An id the partition holds no row for is dropped rather than left a gap. */
    byIds(key: Key, ids: readonly string[]): Vm[];
    /** The same set keyed by id, for a caller that indexes rather than iterates. */
    mapByIds(key: Key, ids: readonly string[]): Record<string, Vm>;
    /** Every row matching `filter` within the partition. */
    where(key: Key, filter?: Partial<Row>): Vm[];
    /** Every row in the partition. */
    all(key: Key): Vm[];
}
/** The memo a projection holds its view models in: one per row, revalidated against that row's digest. */
export type RowVmMemo<Key, Vm> = Memo<Key, BoundSourceMemo<Vm | undefined, readonly ['row']>>;
/** The declaration a projection's memo is built from, so the store accounts for it with every other memo it holds. */
export declare function rowVmMemo<Vm>(max: number): MemoDeclaration;
/**
 * What a projection needs from the store around it: the rows, how a key addresses them, and the memo its view models
 * live in — declared through the store's own `memos` block, so they are accounted for with the rest rather than off
 * to one side.
 */
export interface RowProjectionContext<Row extends RowShape, Key, Vm> {
    store: string;
    table: RowTable<Row>;
    filter: (key: Key) => Partial<Row>;
    memo: RowVmMemo<Key, Vm>;
}
export declare function createRowProjection<Row extends RowShape, Key, Vm>(ctx: RowProjectionContext<Row, Key, Vm>, def: RowProjectionDef<Row, Vm>): RowProjection<Key, Row, Vm>;
//# sourceMappingURL=projection.d.ts.map