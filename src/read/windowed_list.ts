/**
 * A list read paired with a per-row detail read. Rows load their detail in blocks, so the rows of a block share one
 * read however many of them call `useItem`.
 */

import { useMemo } from 'react';

import { getOrCreate } from '../collections';
import type { ReadOptions } from './facade';
import { DataResult } from '../store_result';

const EMPTY_IDS: readonly string[] = [];

/** The reads a {@link createWindowedList} is built from. */
export interface WindowedListSpec<Params, Row extends object, Detail> {
  /** The read of the whole list. */
  useList: (args: {
    /** The read's args. */
    params: Params;
  } & ReadOptions) => DataResult<Row[]>;
  /** A row's id. */
  idOf: (row: Row) => string;
  /** The detail a list row already carries, if any; such a row reads no detail. */
  prehydrated: (row: Row) => Detail | undefined;
  /**
   * The detail read for a block of ids, keyed by id. A hook, called on every render of every row; it should read nothing
   * when `enabled` is false.
   */
  useDetailByIds: (params: Params, ids: readonly string[], enabled: boolean) => Record<string, Detail> | undefined;
  /** How many rows share one detail read; 50 by default. */
  blockSize?: number;
}

/** A block of rows that share one detail read. Every row in the block passes the same object to `useItem`. */
export interface WindowedBlock<Params> {
  /** The list's params. */
  params: Params;
  /** The ids of the block's rows. */
  ids: readonly string[];
}

/**
 * A long list whose rows need detail the list read doesn't carry. Use `useList` to read the list, `useBlocks` where it
 * renders, and `useItem` in each row. A row outside the `rows` passed to `useBlocks` still gets its detail, read alone.
 */
export interface WindowedList<Params, Row extends object, Detail> {
  /** The read of the whole list. */
  useList: (args: {
    /** The read's args. */
    params: Params;
  } & ReadOptions) => DataResult<Row[]>;
  /**
   * Splits the rendered rows into blocks, returning a function that gives a row its block. Call it once where the list
   * renders, and pass each row its index in `rows`, which finds its block without scanning the list. A row not at that
   * index, or called without one, gets a block of its own.
   */
  useBlocks: (
    args: {
      /** The list's params. */
      params: Params;
      /** The rows being rendered, in order. */
      rows: readonly Row[];
    },
  ) => (row: Row, index?: number) => WindowedBlock<Params>;
  /** One row's detail: what the list row carries, or else its block's detail read. */
  useItem: (
    args: {
      /** The row and its block. */
      params: {
        /** The row. */
        row: Row;
        /** The block `useBlocks` gave the row. */
        block: WindowedBlock<Params>;
      };
    },
  ) => Detail | undefined;
}

/**
 * One row's detail: what the list row already carries, or else the detail read for its block. `useDetailByIds` is a
 * hook and is called on every render, reading nothing when `enabled` is false.
 */
export function useWindowedDetail<D>(
  prehydrated: D | undefined,
  id: string,
  blockIds: readonly string[] | undefined,
  useDetailByIds: (ids: readonly string[], enabled: boolean) => Record<string, D> | undefined,
): D | undefined {
  // Nullish, not falsy: a `Detail` of `0` or `''` is a value the list carried. Must match the return below.
  const need = prehydrated == null;
  const ids = useMemo(() => (need ? blockIds ?? [id] : EMPTY_IDS), [need, blockIds, id]);
  const detail = useDetailByIds(ids, need);
  return prehydrated ?? detail?.[id];
}

/**
 * Creates a {@link WindowedList}, for a virtualized list too long to load detail for every row, such as a ranking of
 * thousands of players with a few dozen on screen. Reading detail in blocks avoids a separate read and subscription for
 * every row on screen.
 */
export function createWindowedList<Params, Row extends object, Detail>(spec: WindowedListSpec<Params, Row, Detail>): WindowedList<Params, Row, Detail> {
  const blockSize = spec.blockSize ?? 50;

  function useList(args: { params: Params } & ReadOptions): DataResult<Row[]> {
    return spec.useList(args);
  }

  function useBlocks({ params, rows }: { params: Params; rows: readonly Row[] }): (row: Row, index?: number) => WindowedBlock<Params> {
    return useMemo(() => {
      // Keyed by block start rather than by row, and filled as rows ask. A virtualized list hands `rows` the whole
      // collection but renders a window of it, so building a block per row up front sized this with the collection
      // -- thousands of map entries and a copy of every row -- to answer for the few dozen on screen.
      const blocks = new Map<number, WindowedBlock<Params>>();
      // A row outside `rows` gets a block of its own, cached so it too keeps one block identity across renders.
      const alone = new Map<Row, WindowedBlock<Params>>();

      const soloFor = (row: Row): WindowedBlock<Params> => getOrCreate(alone, row, () => ({ params, ids: [spec.idOf(row)] }));

      return (row: Row, index = -1): WindowedBlock<Params> => {
        // The index is the caller's claim about where the row sits; anything it does not identify is treated as a row
        // `rows` never covered, which is what an out-of-range or omitted index means.
        if (rows[index] !== row) return soloFor(row);

        const start = index - (index % blockSize);
        return getOrCreate(blocks, start, () => {
          const end = Math.min(start + blockSize, rows.length);
          // Hydrate only the rows still missing their detail.
          const ids: string[] = [];
          for (let at = start; at < end; at++) {
            const member = rows[at];
            if (!spec.prehydrated(member)) ids.push(spec.idOf(member));
          }
          return { params, ids };
        });
      };
    }, [params, rows]);
  }

  function useItem({ params }: { params: { row: Row; block: WindowedBlock<Params> } }): Detail | undefined {
    const { row, block } = params;
    const useDetailByIds = (ids: readonly string[], enabled: boolean): Record<string, Detail> | undefined => spec.useDetailByIds(block.params, ids, enabled);
    return useWindowedDetail(spec.prehydrated(row), spec.idOf(row), block.ids, useDetailByIds);
  }

  return { useList, useBlocks, useItem };
}
