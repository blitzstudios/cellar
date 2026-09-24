/**
 * A view model per unit, rebuilt only when that unit changed.
 *
 * The problem this exists for. Rows come back from SQLite as fresh objects, so a read that rebuilt its view models on
 * every write would hand its subscribers new references and repaint all of them, whether or not anything they show
 * changed. On the heap that never happened: the response object was shared, so an unchanged entry kept its identity.
 *
 * A projection buys that back. Every write reports the units it changed, so a projection keeps each unit's view model
 * until its unit changes and hands back the same reference until then, which is what lets the shallow-equal comparison
 * above it bail its readers out. A read of named units depends on those units alone, so a write that changed others
 * leaves it asleep. A store declares one per view-model shape and every read of that shape shares it, so a unit is
 * built once however many reads ask for it.
 */
import { BoundUnitMemo, Memo, MemoDeclaration } from '../caches';
import { RowShape, RowTable } from '../table/types';
/** How to build a view model from one unit's rows, and how many built view models to keep. */
export interface RowProjectionDef<Row extends RowShape, Vm> {
    /** The projection's name, shown with the store's in warnings — `player.card`. */
    name: string;
    /** How many built view models to keep. A read asking for more units than this can't be served from the cache. */
    max: number;
    /**
     * Builds the view model from one unit's rows, in storage order, or returns `undefined` for a unit that shouldn't have
     * one. A table with one row per unit passes a one-row list, so it reads `of: ([row]) => …`.
     */
    of: (rows: readonly Row[]) => Vm | undefined;
    /**
     * Text added to the warning raised when a read asks for more units than `max`, for a projection where raising `max`
     * is the wrong fix — such as a rich shape meant for one unit at a time, which should point at the lean one.
     */
    advice?: string;
}
/**
 * A view model built per unit and cached, which reads get their results from. A unit is built once however many reads
 * ask, rebuilt only when its rows change, and the same object is returned until then.
 */
export interface RowProjection<Key, Row extends RowShape, Vm> {
    /**
     * The view model for one unit, or `undefined` if the partition has no rows for it. Re-renders only when that unit
     * changes.
     */
    one(key: Key, id: string): Vm | undefined;
    /** The view models for `ids`, in that order. An id with no rows in the partition is skipped, not left as a gap. */
    byIds(key: Key, ids: readonly string[]): Vm[];
    /** The view models for `ids`, keyed by id, for a caller that looks them up rather than iterates. */
    mapByIds(key: Key, ids: readonly string[]): Record<string, Vm>;
    /** The view models for every unit with rows matching `filter`. Re-renders when anything in the partition changes. */
    where(key: Key, filter?: Partial<Row>): Vm[];
    /** The view models for every unit in the partition. Re-renders when anything in the partition changes. */
    all(key: Key): Vm[];
}
/** The memo a projection holds its view models in: one per unit, and per filter where a filter can cut a unit's rows. */
export type RowVmMemo<Key, Vm> = Memo<Key, BoundUnitMemo<Vm | undefined, readonly ['scope']>>;
/** The declaration a projection's memo is built from, so the store accounts for it with every other memo it holds. */
export declare function rowVmMemo<Vm>(max: number): MemoDeclaration;
/**
 * What a projection needs from the store around it: the rows, how a key addresses them, the memo its view models live
 * in, and the partition's version, which a read over the whole partition depends on.
 */
export interface RowProjectionContext<Row extends RowShape, Key, Vm> {
    store: string;
    table: RowTable<Row>;
    filter: (key: Key) => Partial<Row>;
    memo: RowVmMemo<Key, Vm>;
    trackPartition: (key: Key) => void;
}
export declare function createRowProjection<Row extends RowShape, Key, Vm>(ctx: RowProjectionContext<Row, Key, Vm>, def: RowProjectionDef<Row, Vm>): RowProjection<Key, Row, Vm>;
//# sourceMappingURL=projection.d.ts.map