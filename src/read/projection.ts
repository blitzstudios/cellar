/**
 * Projections: view models built from table rows one unit at a time, and cached per unit.
 *
 * A unit is all the rows sharing one value of the table's unit column, such as one player's rows (`player_id`). A
 * projection turns a unit's rows into a view model (the object a screen renders), keeps it, and returns the same object
 * until a write changes that unit's rows. Rows come out of SQLite as new objects on every query, so without this, every
 * read after every write would build new view models and re-render every component showing one, changed or not.
 *
 * Every write reports which units it changed, so a projection rebuilds only those. A read that asks for particular
 * units ({@linkcode RowProjection.one | one}, {@linkcode RowProjection.byIds | byIds}) depends on just those units, so
 * a write to other units doesn't re-run it. A store declares one projection per view-model shape, and every read of
 * that shape shares it, so each unit is built once however many reads ask for it.
 */

import { BoundUnitMemo, byUnit, Memo, MemoDeclaration } from '../caches';
import { stableKey } from '../args_key';
import { createOnceGuard } from '../diagnostics/once_guard';
import { covered } from '../table/read_coverage';
import { RowShape, RowTable } from '../table/types';
import type { ReadDef } from './surface';

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
   * {@linkcode RowProjectionDef.max | max} units discards what it just built, rebuilding every one after every write,
   * and warns in dev.
   */
  max: number;
  /**
   * Builds the view model for one unit from its rows (all rows in the partition with that unit value, in storage
   * order), or returns `undefined` for a unit that shouldn't have one. It runs once per unit, and again only after a
   * write changes that unit's rows. In a table with one row per unit, it gets a one-row list: `of: ([row]) => …`.
   */
  of: (rows: readonly Row[]) => Vm | undefined;
  /**
   * Text added to the dev warning shown when a read asks for more units than {@linkcode RowProjectionDef.max | max},
   * for a projection where raising {@linkcode RowProjectionDef.max | max} is the wrong fix, such as a detailed shape
   * meant for one unit at a time, which should point to the lean one.
   */
  advice?: string;
}

/**
 * A declared projection: view models built from a unit's rows, one per unit, cached and returned as the same object
 * until a write changes that unit's rows. A unit is all the rows sharing one value of the table's unit column, such as
 * one player's rows. Reads use these methods in their {@linkcode ReadDef.select | select}. Every method takes the
 * partition key first (a partition is the set of rows one fetch returns and replaces), and reads only that partition's
 * rows.
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
   * The same view models as {@linkcode RowProjection.byIds | byIds}, as an object keyed by id instead of a list, for a
   * caller that looks them up. An id with no rows in the partition is left out. A read that calls it depends on those
   * units only.
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

const thrashWarned = createOnceGuard();

/**
 * The memo a projection holds its view models in: one per unit, and per filter where a filter can cut a unit's rows.
 */
export type RowVmMemo<Key, Vm> = Memo<Key, BoundUnitMemo<Vm | undefined, readonly ['scope']>>;

/** The declaration a projection's memo is built from, so the store accounts for it with every other memo it holds. */
export function rowVmMemo<Vm>(max: number): MemoDeclaration {
  return byUnit<Vm | undefined>()({ max, by: ['scope'] }) as MemoDeclaration;
}

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

/** The scope of a read no filter narrows: the unit's whole rows, which every such read shares. */
const WHOLE_UNIT = '';

export function createRowProjection<Row extends RowShape, Key, Vm>(
  ctx: RowProjectionContext<Row, Key, Vm>,
  def: RowProjectionDef<Row, Vm>,
): RowProjection<Key, Row, Vm> {
  const { store, table, filter, memo, trackPartition } = ctx;
  const unit = table.unit;

  /**
   * Whether a unit is one row, which is what decides if a filtered read can share its view model with an unfiltered
   * one. With one row per unit, a filter either includes the unit's row or not, so every read builds the same view
   * model from it. With several, a filter can include some of a unit's rows — a traded player's games for one team —
   * and the view model built from those is a different one, held under the filter. Worked out from the first key,
   * since the partition's filter is a function of one; the same for every key of a store.
   */
  let singleRow: boolean | undefined;
  const isSingleRow = (key: Key): boolean => {
    if (singleRow === undefined) {
      const fixed = new Set(Object.keys(filter(key)));
      const rest = table.primaryKey.filter((column) => !fixed.has(column));
      singleRow = rest.length === 1 && rest[0] === unit;
    }
    return singleRow;
  };
  const scopeOf = (key: Key, extra: Partial<Row> | undefined): string =>
    !extra || isSingleRow(key) || !Object.keys(extra).length ? WHOLE_UNIT : stableKey(extra);

  const warnOnThrash = (count: number): void => {
    if (!__DEV__ || count <= def.max || thrashWarned.seen(store, def.name)) return;
    // eslint-disable-next-line no-console
    console.warn(
      `[${store}_store] the '${def.name}' projection was asked for ${count} units but holds ${def.max}, so this read ` +
        'evicts what it just built and rebuilds every view model on every change. Raise `max` past the largest read, ' +
        `or read a narrower slice.${def.advice ? ` ${def.advice}` : ''}`,
    );
  };

  /** Builds the view models for `units` from one query, grouped by unit in storage order. */
  const buildMany = (scope: Partial<Row>, units: readonly string[]): Map<string, Vm | undefined> => {
    const grouped = new Map<string, Row[]>();
    for (const row of table.findIn(scope, unit, units)) {
      const id = String(row[unit]);
      const list = grouped.get(id);
      if (list) list.push(row);
      else grouped.set(id, [row]);
    }
    const out = new Map<string, Vm | undefined>();
    for (const id of units) {
      const rows = grouped.get(id);
      out.set(id, rows ? def.of(rows) : undefined);
    }
    return out;
  };

  function resolve(key: Key, ids: readonly string[], extra?: Partial<Row>): Map<string, Vm | undefined> {
    warnOnThrash(ids.length);
    const scope = extra ? { ...filter(key), ...extra } : filter(key);
    return memo.for(key).readMany(ids, scopeOf(key, extra), (missing) => buildMany(scope, missing));
  }

  const listed = (resolved: Map<string, Vm | undefined>, order: Iterable<string>): Vm[] => {
    const out: Vm[] = [];
    for (const id of order) {
      const vm = resolved.get(id);
      if (vm !== undefined) out.push(vm);
    }
    return out;
  };

  const overFilter = (key: Key, extra?: Partial<Row>): Vm[] => {
    // Which units the filter holds can change with any write to the partition, so this depends on all of it.
    trackPartition(key);
    const scope = extra ? { ...filter(key), ...extra } : filter(key);
    const members = covered(() => table.unitsWhere(scope));
    return listed(resolve(key, members, extra), members);
  };

  return {
    one: (key, id) =>
      memo.for(key).read(id, WHOLE_UNIT, () => {
        const rows = table.find({ ...filter(key), [unit]: id } as Partial<Row>);
        return rows.length ? def.of(rows) : undefined;
      }),

    byIds: (key, ids) => (ids.length ? listed(resolve(key, ids), ids) : []),

    mapByIds: (key, ids) => {
      const out: Record<string, Vm> = {};
      if (!ids.length) return out;
      const resolved = resolve(key, ids);
      for (const id of ids) {
        const vm = resolved.get(id);
        if (vm !== undefined) out[id] = vm;
      }
      return out;
    },

    where: (key, extra) => overFilter(key, extra),

    all: (key) => overFilter(key),
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { ReadDef };
