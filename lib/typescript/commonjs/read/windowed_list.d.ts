/**
 * A whole-collection list read paired with the per-row detail read that indexes back into it. Rows resolve in
 * blocks, so `useItem` collapses to one hydration per block however many rows call it.
 */
import type { ReadOptions } from './facade';
import { DataResult } from '../store_result';
/**
 * What a windowed list is assembled from: the read for the whole collection, a row's identity, whatever detail a list
 * row already carries, and the plural read a block of ids hydrates through. `useDetailByIds` is called as a hook on
 * every row's render, so it has to be one, and `enabled` and the ids it is handed are what gate it.
 */
export interface WindowedListSpec<Params, Row extends object, Detail> {
    useList: (args: {
        params: Params;
    } & ReadOptions) => DataResult<Row[]>;
    idOf: (row: Row) => string;
    prehydrated: (row: Row) => Detail | undefined;
    useDetailByIds: (params: Params, ids: readonly string[], enabled: boolean) => Record<string, Detail> | undefined;
    /** Rows per hydration, default 50. */
    blockSize?: number;
}
/** The handle every row in a block shares, which collapses their `useItem` calls onto one read key. */
export interface WindowedBlock<Params> {
    params: Params;
    ids: readonly string[];
}
/**
 * The three pieces a screen uses together: `useList` where the list is read, `useBlocks` beside it, and `useItem` in
 * each row. A row the parent's `rows` didn't cover still resolves, hydrating alone rather than sharing a block.
 */
export interface WindowedList<Params, Row extends object, Detail> {
    useList: (args: {
        params: Params;
    } & ReadOptions) => DataResult<Row[]>;
    /**
     * Call once where the list renders, over the rows being rendered; hand each row the block the result maps it to.
     * Pass the row's index in `rows` — blocks are built as they are asked for, and the index is what finds one without
     * walking the list. A row `rows` does not hold at that index, including the default, hydrates on its own.
     */
    useBlocks: (args: {
        params: Params;
        rows: readonly Row[];
    }) => (row: Row, index?: number) => WindowedBlock<Params>;
    useItem: (args: {
        params: {
            row: Row;
            block: WindowedBlock<Params>;
        };
    }) => Detail | undefined;
}
/**
 * The per-row half: one row's detail, taken from what the list row already carried or from the block hydration its
 * neighbours share. `useDetailByIds` is a hook and runs on every render; `enabled` and the `ids` do the gating.
 */
export declare function useWindowedDetail<D>(prehydrated: D | undefined, id: string, blockIds: readonly string[] | undefined, useDetailByIds: (ids: readonly string[], enabled: boolean) => Record<string, D> | undefined): D | undefined;
/**
 * Builds one, for a virtualized list too long to hydrate whole whose rows still need detail the list itself does not
 * carry — a ranked player list, where the rows on screen are a few dozen out of thousands. The alternative is a read
 * per row, which is one subscription and one hydration per row on screen: the fan-out the read surface warns about.
 */
export declare function createWindowedList<Params, Row extends object, Detail>(spec: WindowedListSpec<Params, Row, Detail>): WindowedList<Params, Row, Detail>;
//# sourceMappingURL=windowed_list.d.ts.map