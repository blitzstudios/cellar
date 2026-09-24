/**
 * Derived values: a value derived from each unit's rows, usually a view model, cached per unit.
 *
 * A unit is all the rows sharing one value of the table's unit column, such as one player's rows (`player_id`). Derived
 * values turn a unit's rows into a value (typically the object a screen renders), keep it, and return the same object
 * until a write changes that unit's rows. Rows come out of SQLite as new objects on every query, so without this, every
 * read after every write would build new values and re-render every component showing one, changed or not.
 *
 * Every write reports which units it changed, so only those units' values are rebuilt. A read that asks for particular
 * units ({@linkcode DerivedValues.one | one}, {@linkcode DerivedValues.byIds | byIds}) depends on just those units, so
 * a write to other units doesn't re-run it. A store declares one set of derived values per shape, and every read of
 * that shape shares it, so each unit's value is built once however many reads ask for it.
 */
import { BoundUnitMemo, Memo, MemoDeclaration } from '../caches';
import { RowShape, RowTable } from '../table/types';
import type { ReadDef } from './surface';
/**
 * The definition of a set of derived values, passed to `derive`: how to build one unit's value from its rows (usually a
 * view model), and how many built values to keep. A unit is all the rows sharing one value of the table's unit column,
 * such as one player's rows.
 */
export interface DerivedValuesDef<Row extends RowShape, V> {
    /** A name for these derived values, shown with the store's name in warnings, such as `card` for player cards. */
    name: string;
    /**
     *    * How many built values to keep, across all partitions; beyond that, the least recently used are discarded and
     * rebuilt when asked for again. Set it above the most units one screen reads at once: a read asking for more than
     * {@linkcode DerivedValuesDef.max | max} units discards what it just built, rebuilding every one after every write,
     * and warns in dev.
     */
    max: number;
    /**
     * * Builds one unit's value from its rows (all rows in the partition with that unit value, in storage order), usually
     * a view model, or returns `undefined` for a unit that shouldn't have one. It runs once per unit, and again only
     * after a write changes that unit's rows. In a table with one row per unit, it gets a one-row list: `fromRows:
     * ([row]) => …`.
     */
    fromRows: (rows: readonly Row[]) => V | undefined;
    /**
     * Text added to the dev warning shown when a read asks for more units than {@linkcode DerivedValuesDef.max | max}, *
     * where raising {@linkcode DerivedValuesDef.max | max} is the wrong fix, such as a detailed shape meant for one unit
     * at a time, which should point to the lean one.
     */
    advice?: string;
}
/**
 * A declared set of derived values, as `derive` returns it: one value per unit, built from the unit's rows (usually a
 * view model), cached, and returned as the same object until a write changes that unit's rows. A unit is all the rows
 * sharing one value of the table's unit column, such as one player's rows. Reads use these methods in their
 * {@linkcode ReadDef.select | select}. Every method takes the partition key first (a partition is the set of rows one
 * fetch returns and replaces), and reads only that partition's rows.
 */
export interface DerivedValues<Key, Row extends RowShape, V> {
    /**
     *    * The value for the unit whose unit-column value is `id` (such as a `player_id`), or `undefined` if the
     * partition has no rows for it. A read that calls it depends on that unit only: it re-runs when a write changes that
     * unit's rows, and not for writes to other units.
     */
    one(key: Key, id: string): V | undefined;
    /**
     *    * The values for the units whose unit-column values are `ids`, in the order of `ids`; an id with no rows in the
     * partition is left out. Builds every missing one with a single query. A read that calls it depends on those units
     * only.
     */
    byIds(key: Key, ids: readonly string[]): V[];
    /**
     *    * The same values as {@linkcode DerivedValues.byIds | byIds}, as an object keyed by id instead of a list, for a
     * caller that looks them up. An id with no rows in the partition is left out. A read that calls it depends on those
     * units only.
     */
    mapByIds(key: Key, ids: readonly string[]): Record<string, V>;
    /**
     * * The values for every unit that has rows matching `filter` (column values, on top of the partition's), such as `{
     * team: 'KC' }`, in storage order. Where a unit has several rows, its value is built from just the rows that match. A
     * read that calls it depends on the whole partition, since any write can change which units match.
     */
    where(key: Key, filter?: Partial<Row>): V[];
    /**
     *    * The values for every unit in the partition, in storage order. A read that calls it depends on the whole
     * partition, since any write can add or remove units.
     */
    all(key: Key): V[];
}
/** The memo derived values are kept in: one per unit, and per filter where a filter can cut a unit's rows. */
export type DerivedValueMemo<Key, V> = Memo<Key, BoundUnitMemo<V | undefined, readonly ['scope']>>;
/** The declaration derived values' memo is built from, so the store accounts for it with every other memo it holds. */
export declare function derivedValueMemo<V>(max: number): MemoDeclaration;
/**
 * What derived values need from the store around them: the rows, how a key addresses them, the memo their values live
 * in, and the partition's version, which a read over the whole partition depends on.
 */
export interface DerivedValuesContext<Row extends RowShape, Key, V> {
    store: string;
    table: RowTable<Row>;
    filter: (key: Key) => Partial<Row>;
    memo: DerivedValueMemo<Key, V>;
    trackPartition: (key: Key) => void;
}
export declare function createDerivedValues<Row extends RowShape, Key, V>(ctx: DerivedValuesContext<Row, Key, V>, def: DerivedValuesDef<Row, V>): DerivedValues<Key, Row, V>;
export type { ReadDef };
//# sourceMappingURL=derived_values.d.ts.map