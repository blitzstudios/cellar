/**
 * How a key is derived from what a read varies by. Everything here is a sharing decision: two calls that key alike
 * share one cache entry, so a value that changes the answer and not the key would serve one caller another's data.
 */

import { cacheKey, isVaryPresent, partitionsKey, stableKey, varyKey, VaryValue } from '../args_key';
import { resetOnceGuards } from '../diagnostics/once_guard';
import { itDev } from '../testing/dev_mode';

describe('stableKey', () => {
  it('separates every value that differs, at any depth', () => {
    const base = stableKey([null, {}]);

    expect(stableKey([null, { orderBy: { key: 'rush_yd' } }])).not.toBe(base);
    expect(stableKey([null, { orderBy: { key: 'rush_yd' } }])).not.toBe(stableKey([null, { orderBy: { key: 'pts_ppr' } }]));
    expect(stableKey([null, { orderBy: { key: 'rush_yd', direction: 'asc' } }])).not.toBe(stableKey([null, { orderBy: { key: 'rush_yd', direction: 'desc' } }]));
    expect(stableKey([null, { limit: 5 }])).not.toBe(base);
    expect(stableKey([null, { positions: ['RB'] }])).not.toBe(base);
    expect(stableKey([{ rush_yd: 1 }, {}])).not.toBe(base);
  });

  it('is insensitive to key order, so two callers building the same options differently share one entry', () => {
    expect(stableKey({ limit: 5, team: 'KC' })).toBe(stableKey({ team: 'KC', limit: 5 }));
    expect(stableKey([{ rush_yd: 1, pts_ppr: 2 }, {}])).toBe(stableKey([{ pts_ppr: 2, rush_yd: 1 }, {}]));
  });

  it('takes an absent field and an explicit undefined as the same value', () => {
    expect(stableKey({ team: undefined })).toBe(stableKey({}));
  });

  it('keeps a nested key from reading as part of its own value', () => {
    // Unquoted, both of these would render `{a:1,b:2}`.
    expect(stableKey({ 'a:1,b': 2 })).not.toBe(stableKey({ a: 1, b: 2 }));
  });

  it('separates a list from the value it holds, and an empty one from an absent one', () => {
    expect(stableKey(['a'])).not.toBe(stableKey('a'));
    expect(stableKey([])).not.toBe(stableKey(undefined));
  });

  itDev('warns once about a value that is not plain data, which would key as if it were empty', () => {
    resetOnceGuards();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const held = new Map([['a', 1]]);
      const other = new Map([['b', 2]]);

      // The report is the guarantee here: the keys themselves genuinely do collide, which is the point of warning.
      expect(stableKey(held)).toBe(stableKey(other));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('not plain data');

      stableKey(new Map());
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  itDev('says nothing about plain data, at any depth', () => {
    resetOnceGuards();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      stableKey({ a: [1, { b: null }], c: 'd' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('cacheKey', () => {
  it('keeps parts apart, including where a part holds the character a reader would have joined on', () => {
    expect(cacheKey('nfl', 'p1')).not.toBe(cacheKey('nflp', '1'));
    // The separator is a control character precisely so a part like `clubsoccer:epl` cannot split a key.
    expect(cacheKey('clubsoccer:epl', 'p1')).not.toBe(cacheKey('clubsoccer', 'epl:p1'));
  });
});

describe('varyKey', () => {
  it('keys by the partition and every vary value, so one partition read two ways holds two entries', () => {
    expect(varyKey(['nfl'], ['KC'])).not.toBe(varyKey(['nfl'], ['SF']));
    expect(varyKey(['nfl'], ['KC'])).not.toBe(varyKey(['nba'], ['KC']));
    expect(varyKey(['nfl'], [])).not.toBe(varyKey(['nfl'], ['KC']));
  });

  it('keys an object vary value by its content, so a caller rebuilding one per render still hits', () => {
    expect(varyKey(['nfl'], [{ limit: 5, team: 'KC' }])).toBe(varyKey(['nfl'], [{ team: 'KC', limit: 5 }]));
  });
});

describe('partitionsKey', () => {
  it('makes the same partitions named in a different order, or grouped differently, a different set', () => {
    expect(partitionsKey([['nfl'], ['nba']])).not.toBe(partitionsKey([['nba'], ['nfl']]));
    expect(partitionsKey([['nfl', 'nba']])).not.toBe(partitionsKey([['nfl'], ['nba']]));
  });
});

describe('isVaryPresent', () => {
  it('counts a value a read cannot address with as absent, and a falsy one it can as present', () => {
    const absent: VaryValue[] = [undefined, null, '', []];
    const present: VaryValue[] = [0, false, 'KC', ['a'], {}];

    expect(absent.filter(isVaryPresent)).toEqual([]);
    expect(present.every(isVaryPresent)).toBe(true);
  });
});
