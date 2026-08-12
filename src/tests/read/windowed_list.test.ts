import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { createWindowedList, useWindowedDetail } from '../../read/windowed_list';
import { makeResult } from '../../store_result';

/* global globalThis */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Params = { sport: string };
type Row = { id: string; display?: string };
type Detail = { label: string };

/** Stands in for a batched store read, recording the id sets it is asked for. */
function makeSpecHarness(opts: { prehydrate?: (row: Row) => Detail | undefined; blockSize?: number } = {}) {
  const calls: string[][] = [];
  const list = { rows: [] as Row[] };

  const useDetailByIds = (params: Params, ids: readonly string[], enabled: boolean): Record<string, Detail> | undefined => {
    if (!enabled || ids.length === 0) return undefined;
    calls.push([...ids]);
    const out: Record<string, Detail> = {};
    for (const id of ids) out[id] = { label: `${params.sport}:${id}` };
    return out;
  };

  const windowed = createWindowedList<Params, Row, Detail>({
    useList: () => makeResult(list.rows, 'success'),
    idOf: (row) => row.id,
    prehydrated: opts.prehydrate ?? (() => undefined),
    useDetailByIds,
    blockSize: opts.blockSize,
  });

  const Child = ({
    row,
    block,
    sink,
    at,
  }: {
    row: Row;
    block: ReturnType<ReturnType<typeof windowed.useBlocks>>;
    sink: (string | undefined)[];
    at: number;
  }): null => {
    sink[at] = windowed.useItem({ params: { row, block } })?.label;
    return null;
  };

  const makeParent = (params: Params, sink: (string | undefined)[]) =>
    function Parent(): React.ReactElement {
      const { data } = windowed.useList({ params });
      const blockOf = windowed.useBlocks({ params, rows: data });
      return React.createElement(
        React.Fragment,
        null,
        data.map((row, index) => React.createElement(Child, { key: row.id, row, block: blockOf(row), sink, at: index })),
      );
    };

  const render = (rows: Row[], params: Params = NFL): { labels: (string | undefined)[]; distinctReads: number } => {
    list.rows = rows;
    const labels: (string | undefined)[] = [];
    act(() => {
      TestRenderer.create(React.createElement(makeParent(params, labels)));
    });
    return { labels, distinctReads: new Set(calls.map((ids) => ids.join(','))).size };
  };

  return { render, makeParent, calls, windowed, list };
}

const NFL: Params = { sport: 'nfl' };
const rowsOf = (count: number, from = 0): Row[] => Array.from({ length: count }, (_value, index) => ({ id: `p${from + index}` }));

describe('createWindowedList', () => {
  it('resolves every row, so batching is invisible to the row', () => {
    const harness = makeSpecHarness();
    const { labels } = harness.render(rowsOf(4));

    expect(labels).toEqual(['nfl:p0', 'nfl:p1', 'nfl:p2', 'nfl:p3']);
  });

  it('hydrates a block once however many rows read from it', () => {
    const harness = makeSpecHarness();
    const { distinctReads } = harness.render(rowsOf(40));

    expect(distinctReads).toBe(1);
    expect(harness.calls[0]).toHaveLength(40);
  });

  it('splits a long list into blocks, so the working set stays bounded instead of growing with the list', () => {
    const harness = makeSpecHarness({ blockSize: 10 });
    const { distinctReads, labels } = harness.render(rowsOf(35));

    expect(distinctReads).toBe(4);
    expect(harness.calls.every((ids) => ids.length <= 10)).toBe(true);
    expect(labels[34]).toBe('nfl:p34');
  });

  it("asks only for the rows in the reader's own block, so a row never drags in the rest of the list", () => {
    const harness = makeSpecHarness({ blockSize: 10 });
    harness.render(rowsOf(30));

    const blocks = new Set(harness.calls.map((ids) => ids.join(',')));
    expect(
      blocks.has(
        rowsOf(10, 0)
          .map((row) => row.id)
          .join(','),
      ),
    ).toBe(true);
    expect(
      blocks.has(
        rowsOf(10, 20)
          .map((row) => row.id)
          .join(','),
      ),
    ).toBe(true);
  });

  it('skips the read entirely for a row the list already carried detail for', () => {
    const harness = makeSpecHarness({ prehydrate: (row) => (row.display ? { label: row.display } : undefined) });
    const { labels } = harness.render([{ id: 'p0', display: 'carried' }, { id: 'p1' }]);

    expect(labels[0]).toBe('carried');
    expect(labels[1]).toBe('nfl:p1');
    expect(harness.calls.flat()).toEqual(['p1']);
  });

  it('carries the params from the list, so a row cannot read a partition its list did not come from', () => {
    const harness = makeSpecHarness();
    const { labels } = harness.render(rowsOf(2));

    expect(labels).toEqual(['nfl:p0', 'nfl:p1']);
  });

  it('reads a row the list left out on its own, since unbatched is a cost and blank is a bug', () => {
    const harness = makeSpecHarness();
    harness.list.rows = rowsOf(2);
    const stray: Row = { id: 'stray' };
    let label: string | undefined = 'unset';

    const Parent = (): React.ReactElement => {
      const blockOf = harness.windowed.useBlocks({ params: NFL, rows: harness.list.rows });
      return React.createElement(Solo, { block: blockOf(stray) });
    };
    const Solo = ({ block }: { block: ReturnType<ReturnType<typeof harness.windowed.useBlocks>> }): null => {
      label = harness.windowed.useItem({ params: { row: stray, block } })?.label;
      return null;
    };
    act(() => {
      TestRenderer.create(React.createElement(Parent));
    });

    expect(label).toBe('nfl:stray');
    expect(harness.calls).toEqual([['stray']]);
  });
});

describe('createWindowedList — two lists over the same rows', () => {
  it('gives each list its own blocks rather than the last render winning', () => {
    const harness = makeSpecHarness();
    const shared = rowsOf(2);
    harness.list.rows = shared;
    const nflLabels: (string | undefined)[] = [];
    const nbaLabels: (string | undefined)[] = [];
    const Nfl = harness.makeParent({ sport: 'nfl' }, nflLabels);
    const Nba = harness.makeParent({ sport: 'nba' }, nbaLabels);

    act(() => {
      TestRenderer.create(React.createElement(React.Fragment, null, React.createElement(Nfl), React.createElement(Nba)));
    });

    expect(nflLabels).toEqual(['nfl:p0', 'nfl:p1']);
    expect(nbaLabels).toEqual(['nba:p0', 'nba:p1']);
  });

  it('hands a row the same block object across re-renders, so its hydration is not re-keyed every render', () => {
    const harness = makeSpecHarness();
    const rows = rowsOf(3);
    harness.list.rows = rows;
    const seen: unknown[] = [];
    const Parent = (): null => {
      const blockOf = harness.windowed.useBlocks({ params: NFL, rows });
      seen.push(blockOf(rows[0]));
      return null;
    };

    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(React.createElement(Parent));
    });
    act(() => {
      tree.update(React.createElement(Parent));
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });
});

describe('useWindowedDetail — a falsy detail is a value, not a miss', () => {
  const render = (prehydrated: number | undefined): { value: number | undefined; asked: string[][] } => {
    const asked: string[][] = [];
    let value: number | undefined;
    const Probe = (): null => {
      value = useWindowedDetail<number>(prehydrated, 'p0', ['p0', 'p1'], (ids, enabled) => {
        asked.push([...ids]);
        return enabled ? { p0: 99 } : undefined;
      });
      return null;
    };
    act(() => {
      TestRenderer.create(React.createElement(Probe));
    });
    return { value, asked };
  };

  it('serves a prehydrated 0 without reading the row again', () => {
    const { value, asked } = render(0);

    expect(value).toBe(0);
    expect(asked).toEqual([[]]);
  });

  it('still reads when nothing was prehydrated', () => {
    const { value, asked } = render(undefined);

    expect(value).toBe(99);
    expect(asked).toEqual([['p0', 'p1']]);
  });
});
