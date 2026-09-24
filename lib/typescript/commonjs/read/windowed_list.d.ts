/**
 * A list read paired with a per-row detail read. Rows load their detail in blocks, so the rows of a block share one
 * read however many of them call `useItem`.
 */
import type { ReadOptions } from './facade';
import { DataResult } from '../store_result';
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
    useBlocks: (args: {
        /** The list's params. */
        params: Params;
        /** The rows being rendered, in order. */
        rows: readonly Row[];
    }) => (row: Row, index?: number) => WindowedBlock<Params>;
    /** One row's detail: what the list row carries, or else its block's detail read. */
    useItem: (args: {
        /** The row and its block. */
        params: {
            /** The row. */
            row: Row;
            /** The block `useBlocks` gave the row. */
            block: WindowedBlock<Params>;
        };
    }) => Detail | undefined;
}
/**
 * One row's detail: what the list row already carries, or else the detail read for its block. `useDetailByIds` is a
 * hook and is called on every render, reading nothing when `enabled` is false.
 */
export declare function useWindowedDetail<D>(prehydrated: D | undefined, id: string, blockIds: readonly string[] | undefined, useDetailByIds: (ids: readonly string[], enabled: boolean) => Record<string, D> | undefined): D | undefined;
/**
 * Creates a {@link WindowedList}, for a virtualized list too long to load detail for every row, such as a ranking of
 * thousands of players with a few dozen on screen. Reading detail in blocks avoids a separate read and subscription for
 * every row on screen.
 */
export declare function createWindowedList<Params, Row extends object, Detail>(spec: WindowedListSpec<Params, Row, Detail>): WindowedList<Params, Row, Detail>;
//# sourceMappingURL=windowed_list.d.ts.map