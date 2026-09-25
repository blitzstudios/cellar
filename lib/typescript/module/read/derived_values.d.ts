/**
 * {@linkcode byUnit} caches: a value derived from each unit's rows, usually a view model, cached per unit.
 *
 * A unit is all the rows sharing one value of the table's unit column, such as one player's rows (`player_id`). Derived
 * values turn a unit's rows into a value (typically the object a screen renders), keep it, and return the same object
 * until a write changes that unit's rows. Rows come out of SQLite as new objects on every query, so without this, every
 * read after every write would build new values and re-render every component showing one, changed or not.
 *
 * Every write reports which units it changed, so only those units' values are rebuilt. A read that asks for particular
 * units ({@linkcode DerivedValues.at | at}, {@linkcode DerivedValues.atEach | atEach}) depends on just those units, so
 * a write to other units doesn't re-run it. A store declares one set of derived values per shape, and every read of
 * that shape shares it, so each unit's value is built once however many reads ask for it.
 */
import { BoundUnitMemo, Memo, MemoDeclaration } from '../caches';
import { RowShape, RowTable } from '../table/types';
import type { ReadDef } from './surface';
import type { Partitions } from '../define_partitions';
/**
 * The definition of a {@linkcode byUnit} cache: how to build one unit's value from its rows (usually a view model), and
 * how many built values to keep. A unit is all the rows sharing one value of the table's unit column, such as one
 * player's rows. The cache's name, shown in warnings, is its key in the {@linkcode Partitions.cache | cache} block.
 */
export interface DerivedValuesDef<Row extends RowShape, V> {
    /**
     * How many built values to keep, across all partitions; beyond that, the least recently used are discarded and
     * rebuilt when asked for again. Set it above the most units one screen reads at once: a read asking for more than
     * {@linkcode DerivedValuesDef.max | max} units discards what it just built, rebuilding every one after every write,
     * and warns in dev.
     */
    max: number;
    /**
     * Builds one unit's value from its rows (all rows in the partition with that unit value, in storage order), usually
     * a view model, or returns `undefined` for a unit that shouldn't have one. It runs once per unit, and again only
     * after a write changes that unit's rows. In a table with one row per unit, it gets a one-row list:
     * `fromRows: ([row]) => …`.
     */
    fromRows: (rows: readonly Row[]) => V | undefined;
    /**
     * Text added to the dev warning shown when a read asks for more units than {@linkcode DerivedValuesDef.max | max},
     * where raising {@linkcode DerivedValuesDef.max | max} is the wrong fix, such as a detailed shape meant for one unit
     * at a time, which should point to the lean one.
     */
    advice?: string;
}
/**
 * A {@linkcode byUnit} cache as a store's {@linkcode Partitions.cache | cache} block returns it: one value per unit, built from the unit's rows (usually a
 * view model), cached, and returned as the same object until a write changes that unit's rows. A unit is all the rows
 * sharing one value of the table's unit column, such as one player's rows.
 *
 * Each value's address is a partition key plus a unit id (a partition is the set of rows one fetch returns and
 * replaces), so every method takes the key first and reads only that partition's rows. Reads call these methods in
 * their {@linkcode ReadDef.select | select}. Name a set after what it holds and the unit it is keyed by, such as
 * `cardsByPlayer`.
 */
export interface DerivedValues<Key, Row extends RowShape, V> {
    /**
     * The value at unit `id` (a value of the unit column, such as a `player_id`), or `undefined` if the partition has no
     * rows for it. A read that calls it depends on that unit only: it re-runs when a write changes that unit's rows, and
     * not for writes to other units.
     */
    at(key: Key, id: string): V | undefined;
    /**
     * The values at each of `ids` (values of the unit column), in the order of `ids`; an id with no rows in the
     * partition is left out. Builds every missing one with a single query. A read that calls it depends on those units
     * only.
     */
    atEach(key: Key, ids: readonly string[]): V[];
    /**
     * The same values as {@linkcode DerivedValues.atEach | atEach}, as an object keyed by id instead of a list, for a
     * caller that looks them up. An id with no rows in the partition is left out. A read that calls it depends on those
     * units only.
     */
    pick(key: Key, ids: readonly string[]): Record<string, V>;
    /**
     * The values for every unit that has rows matching `filter` (column values, on top of the partition's), such as
     * `{ team: 'KC' }`, in storage order. Where a unit has several rows, its value is built from just the rows that
     * match. A read that calls it depends on the whole partition, since any write can change which units match.
     */
    where(key: Key, filter?: Partial<Row>): V[];
    /**
     * The values for every unit in the partition, in storage order. A read that calls it depends on the whole partition,
     * since any write can add or remove units.
     */
    all(key: Key): V[];
}
/**
 * A {@linkcode byUnit} cache's definition, as {@linkcode byUnit} returns it, before a store's
 * {@linkcode Partitions.cache | cache} block attaches it to the store's partitions.
 */
export interface UnitCacheDeclaration<Row extends RowShape, V> {
    readonly kind: 'byUnit';
    readonly def: DerivedValuesDef<Row, V>;
}
/**
 * Declares a cache of values derived from each unit's rows, usually view models, for a store's
 * {@linkcode Partitions.cache | cache} block: one value per unit (a unit is all the rows sharing one value of the
 * table's unit column, such as one player's rows), built from that unit's rows by `fromRows` on first use and kept, as
 * the same object, until a write changes that unit's rows. Reads look values up by partition key and unit id through the
 * {@linkcode DerivedValues} methods, such as {@linkcode DerivedValues.at | at}.
 *
 * Called in two steps, so the value type can be given while the row type comes from the store:
 * `byUnit<GameVM[]>()({ max: 2048, fromRows: rowsToTeamGames })`.
 */
export declare function byUnit<V>(): <Row extends RowShape>(def: DerivedValuesDef<Row, V>) => UnitCacheDeclaration<Row, V>;
/** Whether a {@linkcode Partitions.cache | cache} block entry is a {@linkcode byUnit} cache. */
export declare function isUnitCacheDeclaration(decl: unknown): decl is UnitCacheDeclaration<RowShape, unknown>;
/**
 * The memo a {@linkcode byUnit} cache keeps its values in: one per unit, and per filter where a filter can cut a unit's
 * rows.
 */
export type DerivedValueMemo<Key, V> = Memo<Key, BoundUnitMemo<V | undefined, readonly ['scope']>>;
/** The declaration a {@linkcode byUnit} cache's memo is built from. */
export declare function derivedValueMemo<V>(max: number): MemoDeclaration;
/**
 * What a {@linkcode byUnit} cache needs from the store around it: its name, the rows, how a key addresses them, the
 * memo its values live in, and the partition's version, which a read over the whole partition depends on.
 */
export interface DerivedValuesContext<Row extends RowShape, Key, V> {
    store: string;
    /** The cache's key in the store's {@linkcode Partitions.cache | cache} block, shown in warnings. */
    name: string;
    table: RowTable<Row>;
    filter: (key: Key) => Partial<Row>;
    memo: DerivedValueMemo<Key, V>;
    trackPartition: (key: Key) => void;
}
export declare function createDerivedValues<Row extends RowShape, Key, V>(ctx: DerivedValuesContext<Row, Key, V>, def: DerivedValuesDef<Row, V>): DerivedValues<Key, Row, V>;
export type { Partitions, ReadDef };
//# sourceMappingURL=derived_values.d.ts.map