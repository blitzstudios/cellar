"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createWindowedList = createWindowedList;
exports.useWindowedDetail = useWindowedDetail;
var _react = require("react");
var _collections = require("../collections.js");
/**
 * A list read paired with a per-row detail read. Rows load their detail in blocks, so the rows of a block share one
 * read however many of them call `useItem`.
 */

const EMPTY_IDS = [];

/** The reads a {@link createWindowedList} is built from. */

/** A block of rows that share one detail read. Every row in the block passes the same object to `useItem`. */

/**
 * A long list whose rows need detail the list read doesn't carry. Use `useList` to read the list, `useBlocks` where it
 * renders, and `useItem` in each row. A row outside the `rows` passed to `useBlocks` still gets its detail, read alone.
 */

/**
 * One row's detail: what the list row already carries, or else the detail read for its block. `useDetailByIds` is a
 * hook and is called on every render, reading nothing when `enabled` is false.
 */
function useWindowedDetail(prehydrated, id, blockIds, useDetailByIds) {
  // Nullish, not falsy: a `Detail` of `0` or `''` is a value the list carried. Must match the return below.
  const need = prehydrated == null;
  const ids = (0, _react.useMemo)(() => need ? blockIds ?? [id] : EMPTY_IDS, [need, blockIds, id]);
  const detail = useDetailByIds(ids, need);
  return prehydrated ?? detail?.[id];
}

/**
 * Creates a {@link WindowedList}, for a virtualized list too long to load detail for every row, such as a ranking of
 * thousands of players with a few dozen on screen. Reading detail in blocks avoids a separate read and subscription for
 * every row on screen.
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
      // Keyed by block start rather than by row, and filled as rows ask. A virtualized list hands `rows` the whole
      // collection but renders a window of it, so building a block per row up front sized this with the collection
      // -- thousands of map entries and a copy of every row -- to answer for the few dozen on screen.
      const blocks = new Map();
      // A row outside `rows` gets a block of its own, cached so it too keeps one block identity across renders.
      const alone = new Map();
      const soloFor = row => (0, _collections.getOrCreate)(alone, row, () => ({
        params,
        ids: [spec.idOf(row)]
      }));
      return (row, index = -1) => {
        // The index is the caller's claim about where the row sits; anything it does not identify is treated as a row
        // `rows` never covered, which is what an out-of-range or omitted index means.
        if (rows[index] !== row) return soloFor(row);
        const start = index - index % blockSize;
        return (0, _collections.getOrCreate)(blocks, start, () => {
          const end = Math.min(start + blockSize, rows.length);
          // Hydrate only the rows still missing their detail.
          const ids = [];
          for (let at = start; at < end; at++) {
            const member = rows[at];
            if (!spec.prehydrated(member)) ids.push(spec.idOf(member));
          }
          return {
            params,
            ids
          };
        });
      };
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