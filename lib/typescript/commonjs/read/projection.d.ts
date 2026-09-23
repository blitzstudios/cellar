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
/** What a store declares: how one unit's rows become a view model, and how many of them to hold. */
export interface RowProjectionDef<Row extends RowShape, Vm> {
    /** Names this projection in a diagnostic, alongside the store — `player.card`. */
    name: string;
    /** Bounds the view models held. A read asking for more units than this can never answer from the memo. */
    max: number;
    /**
     * The only app-specific part: a unit's rows, in storage order, to its view model — `undefined` for a unit that does
     * not make one. A table holding one row per unit is handed one, so it reads `of: ([row]) => …`.
     */
    of: (rows: readonly Row[]) => Vm | undefined;
    /**
     * Appended to the warning a read too large for `max` raises, for a store whose answer is not "raise the bound" —
     * a view-model shape meant for one unit at a time says to read the lean shape instead.
     */
    advice?: string;
}
/** A declared projection, as the reads of a store consume it. Every method hands back reference-stable view models. */
export interface RowProjection<Key, Row extends RowShape, Vm> {
    /** The view model for one unit, or `undefined` where the partition holds no rows for it. Depends on that unit. */
    one(key: Key, id: string): Vm | undefined;
    /** In the order `ids` names them. An id the partition holds no rows for is dropped rather than left a gap. */
    byIds(key: Key, ids: readonly string[]): Vm[];
    /** The same set keyed by id, for a caller that indexes rather than iterates. */
    mapByIds(key: Key, ids: readonly string[]): Record<string, Vm>;
    /** Every unit with rows matching `filter` in the partition. Depends on the partition, since membership can move. */
    where(key: Key, filter?: Partial<Row>): Vm[];
    /** Every unit in the partition. Depends on the partition. */
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