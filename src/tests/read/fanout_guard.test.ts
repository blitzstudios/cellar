import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { createReadSurface } from '../../read/surface';
import { describeDev } from '../../testing/dev_mode';
import { resetOnceGuards } from '../../diagnostics/once_guard';
import { createVersionAtom } from '../../reactivity/version_atom';

/* global globalThis */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let warn: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  resetOnceGuards();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  jest.useRealTimers();
});

function fanoutWarnings(): string[] {
  return warn.mock.calls.map((args) => String(args[0])).filter((message) => message.includes('separate reads in one tick'));
}

function makeSurface(name?: string) {
  const atom = createVersionAtom('fanout_test_version');
  const present = new Set<string>(['nfl']);
  const surface = createReadSurface<string>({
    name,
    version: atom,
    toParts: (sport) => [sport],
    has: (sport) => present.has(sport),
    ingest: {
      usePrime: () => ({ isInitialLoading: false, isFetching: false, isError: false }),
      usePrimeMany: () => ({ isInitialLoading: false, isFetching: false, isError: false }),
      ensure: () => {},
      refetch: () => {},
    },
  });

  return surface.read<{ sport: string; id: string }, string>()({
    partition: (args) => args.sport,
    varyBy: ['id'],
    select: (args) => args.id,
    empty: '',
  });
}

function renderRows(surface: { useValue: (args: { sport: string; id: string } | undefined) => unknown }, rows: number): void {
  const Row = ({ id }: { id: string }): null => {
    surface.useValue({ sport: 'nfl', id });
    return null;
  };
  const List = (): React.ReactElement =>
    React.createElement(
      React.Fragment,
      null,
      Array.from({ length: rows }, (_value, index) => React.createElement(Row, { key: index, id: `p${index}` })),
    );
  act(() => {
    TestRenderer.create(React.createElement(List));
  });
  act(() => {
    jest.advanceTimersByTime(1);
  });
}

describeDev('per-row fan-out tripwire', () => {
  it('warns when many rows each read for themselves, naming the store and sampling the args', () => {
    const surface = makeSurface('player');
    renderRows(surface, 60);

    const warnings = fanoutWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[player_store]');
    expect(warnings[0]).toContain('60 separate reads');
    expect(warnings[0]).toContain('nfl\u0000"p0"');
  });

  it('stays quiet for a list whose reads are batched, because one batched read is one arg key', () => {
    const surface = makeSurface('player');
    const Parent = (): null => {
      surface.useValue({ sport: 'nfl', id: Array.from({ length: 40 }, (_value, index) => `p${index}`).join(',') });
      return null;
    };
    act(() => {
      TestRenderer.create(React.createElement(Parent));
    });
    act(() => {
      jest.advanceTimersByTime(1);
    });

    expect(fanoutWarnings()).toEqual([]);
  });

  it('stays quiet below the threshold, so an ordinary screen with a few reads is not flagged', () => {
    const surface = makeSurface('player');
    renderRows(surface, 8);

    expect(fanoutWarnings()).toEqual([]);
  });

  it('stays quiet for a virtualized list reading once per visible row, which is bounded by the viewport', () => {
    const surface = makeSurface('player');
    renderRows(surface, 30);

    expect(fanoutWarnings()).toEqual([]);
  });

  it('warns when each row reads several times over, which scales past a viewport', () => {
    const surface = makeSurface('player');
    const Row = ({ id }: { id: string }): null => {
      surface.useValue({ sport: 'nfl', id: `${id}:stat` });
      surface.useValue({ sport: 'nfl', id: `${id}:proj` });
      surface.useValue({ sport: 'nfl', id: `${id}:game` });
      return null;
    };
    const List = (): React.ReactElement =>
      React.createElement(
        React.Fragment,
        null,
        Array.from({ length: 25 }, (_value, index) => React.createElement(Row, { key: index, id: `p${index}` })),
      );
    act(() => {
      TestRenderer.create(React.createElement(List));
    });
    act(() => {
      jest.advanceTimersByTime(1);
    });

    expect(fanoutWarnings()).toHaveLength(1);
    expect(fanoutWarnings()[0]).toContain('75 separate reads');
  });

  it('warns once per store, so a scrolling list cannot spam the console', () => {
    const surface = makeSurface('player');
    renderRows(surface, 60);
    renderRows(surface, 60);

    expect(fanoutWarnings()).toHaveLength(1);
  });

  it('counts distinct args rather than calls, so many rows sharing one arg key are not fan-out', () => {
    const surface = makeSurface('player');
    const Row = (): null => {
      surface.useValue({ sport: 'nfl', id: 'same' });
      return null;
    };
    const List = (): React.ReactElement =>
      React.createElement(
        React.Fragment,
        null,
        Array.from({ length: 60 }, (_value, index) => React.createElement(Row, { key: index })),
      );
    act(() => {
      TestRenderer.create(React.createElement(List));
    });
    act(() => {
      jest.advanceTimersByTime(1);
    });

    expect(fanoutWarnings()).toEqual([]);
  });

  it('falls back to a generic name when a store did not set one', () => {
    const surface = makeSurface();
    renderRows(surface, 60);

    expect(fanoutWarnings()[0]).toContain('[off_heap_store]');
  });
});
