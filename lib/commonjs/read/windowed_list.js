"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createWindowedList = createWindowedList;
exports.useWindowedDetail = useWindowedDetail;
var _react = require("react");
var _collections = require("../collections.js");
/**
 * A whole-collection list read paired with the per-row detail read that indexes back into it. Rows resolve in
 * blocks, so `useItem` collapses to one hydration per block however many rows call it.
 */

const EMPTY_IDS = [];

/**
 * What a windowed list is assembled from: the read for the whole collection, a row's identity, whatever detail a list
 * row already carries, and the plural read a block of ids hydrates through. `useDetailByIds` is called as a hook on
 * every row's render, so it has to be one, and `enabled` and the ids it is handed are what gate it.
 */

/** The handle every row in a block shares, which collapses their `useItem` calls onto one read key. */

/**
 * The three pieces a screen uses together: `useList` where the list is read, `useBlocks` beside it, and `useItem` in
 * each row. A row the parent's `rows` didn't cover still resolves, hydrating alone rather than sharing a block.
 */

/**
 * The per-row half: one row's detail, taken from what the list row already carried or from the block hydration its
 * neighbours share. `useDetailByIds` is a hook and runs on every render; `enabled` and the `ids` do the gating.
 */
function useWindowedDetail(prehydrated, id, blockIds, useDetailByIds) {
  // Nullish, not falsy: a `Detail` of `0` or `''` is a value the list carried. Must match the return below.
  const need = prehydrated == null;
  const ids = (0, _react.useMemo)(() => need ? blockIds ?? [id] : EMPTY_IDS, [need, blockIds, id]);
  const detail = useDetailByIds(ids, need);
  return prehydrated ?? detail?.[id];
}

/**
 * Builds one, for a virtualized list too long to hydrate whole whose rows still need detail the list itself does not
 * carry — a ranked player list, where the rows on screen are a few dozen out of thousands. The alternative is a read
 * per row, which is one subscription and one hydration per row on screen: the fan-out the read surface warns about.
 */
function createWindowedList(spec) {
  const blockSize = spec.blockSize ?? 50;
  function useList(args) {
    return spec.useList(args);
  }
  function useBlocks({
    params,
    rows
  }) {
    return (0, _react.useMemo)(() => {
      const byRow = new Map();
      for (let start = 0; start < rows.length; start += blockSize) {
        const block = rows.slice(start, start + blockSize);
        // Hydrate only the rows still missing their detail.
        const ids = block.filter(row => !spec.prehydrated(row)).map(spec.idOf);
        const handle = {
          params,
          ids
        };
        for (const row of block) byRow.set(row, handle);
      }
      // A row outside `rows` gets a block of its own, cached so it too keeps one block identity across renders.
      const alone = new Map();
      return row => byRow.get(row) ?? (0, _collections.getOrCreate)(alone, row, () => ({
        params,
        ids: [spec.idOf(row)]
      }));
    }, [params, rows]);
  }
  function useItem({
    params
  }) {
    const {
      row,
      block
    } = params;
    const useDetailByIds = (ids, enabled) => spec.useDetailByIds(block.params, ids, enabled);
    return useWindowedDetail(spec.prehydrated(row), spec.idOf(row), block.ids, useDetailByIds);
  }
  return {
    useList,
    useBlocks,
    useItem
  };
}
//# sourceMappingURL=windowed_list.js.map