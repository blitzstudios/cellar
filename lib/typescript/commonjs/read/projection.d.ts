/**
 * Projections: view models built from table rows one unit at a time, and cached per unit.
 *
 * A unit is all the rows sharing one value of the table's unit column, such as one player's rows (`player_id`). A
 * projection turns a unit's rows into a view model (the object a screen renders), keeps it, and returns the same object
 * until a write changes that unit's rows. Rows come out of SQLite as new objects on every query, so without this, every
 * read after every write would build new view models and re-render every component showing one, changed or not.
 *
 * Every write reports which units it changed, so a projection rebuilds only those. A read that asks for particular
 * units (`one`, `byIds`) depends on just those units, so a write to other units doesn't re-run it. A store declares one
 * projection per view-model shape, and every read of that shape shares it, so each unit is built once however many
 * reads ask for it.
 */
import { BoundUnitMemo, Memo, MemoDeclaration } from '../caches';
import { RowShape, RowTable } from '../table/types';
/**
 * The definition of a projection: how to build a view model from one unit's rows, and how many built view models to
 * keep. A unit is all the rows sharing one value of the table's unit column, such as one player's rows.
 */
export interface RowProjectionDef<Row extends RowShape, Vm> {
    /** The projection's name, shown with the store's name in warnings, such as `card` for a player card view model. */
    name: string;
    /**
     * How many built view models to keep, across all partitions; beyond that, the least recently used are discarded and
     * rebuilt when asked for again. Set it above the most units one screen reads at once: a read asking for more than
     * `max` units discards what it just built, rebuilding every one after every write, and warns in dev.
     */
    max: number;
    /**
     * Builds the view model for one unit from its rows (all rows in the partition with that unit value, in storage
     * order), or returns `undefined` for a unit that shouldn't have one. It runs once per unit, and again only after a
     * write changes that unit's rows. In a table with one row per unit, it gets a one-row list: `of: ([row]) => …`.
     */
    of: (rows: readonly Row[]) => Vm | undefined;
    /**
     * Text added to the dev warning shown when a read asks for more units than `max`, for a projection where raising
     * `max` is the wrong fix, such as a detailed shape meant for one unit at a time, which should point to the lean one.
     */
    advice?: string;
}
/**
 * A declared projection: view models built from a unit's rows, one per unit, cached and returned as the same object
 * until a write changes that unit's rows. A unit is all the rows sharing one value of the table's unit column, such as
 * one player's rows. Reads use these methods in their `select`. Every method takes the partition key first (a
 * partition is the set of rows one fetch returns and replaces), and reads only that partition's rows.
 */
export interface RowProjection<Key, Row extends RowShape, Vm> {
    /**
     * The view model for the unit whose unit-column value is `id` (such as a `player_id`), or `undefined` if the
     * partition has no rows for it. A read that calls it depends on that unit only: it re-runs when a write changes that
     * unit's rows, and not for writes to other units.
     */
    one(key: Key, id: string): Vm | undefined;
    /**
     * The view models for the units whose unit-column values are `ids`, in the order of `ids`; an id with no rows in the
     * partition is left out. Builds every missing one with a single query. A read that calls it depends on those units
     * only.
     */
    byIds(key: Key, ids: readonly string[]): Vm[];
    /**
     * The same view models as `byIds`, as an object keyed by id instead of a list, for a caller that looks them up.
     * An id with no rows in the partition is left out. A read that calls it depends on those units only.
     */
    mapByIds(key: Key, ids: readonly string[]): Record<string, Vm>;
    /**
     * The view models for every unit that has rows matching `filter` (column values, on top of the partition's), such as
     * `{ team: 'KC' }`, in storage order. Where a unit has several rows, its view model is built from just the rows that
     * match. A read that calls it depends on the whole partition, since any write can change which units match.
     */
    where(key: Key, filter?: Partial<Row>): Vm[];
    /**
     * The view models for every unit in the partition, in storage order. A read that calls it depends on the whole
     * partition, since any write can add or remove units.
     */
    all(key: Key): Vm[];
}
/**
 * The memo a projection holds its view models in: one per unit, and per filter where a filter can cut a unit's rows.
 */
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