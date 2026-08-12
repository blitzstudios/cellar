import { evalShredElement, evalShredSpec, ShredOp, ShredSpec } from '../../write/shred_spec';

function specForOp(op: ShredOp, extra?: Partial<ShredSpec>): ShredSpec {
  return {
    version: 1,
    table: 't',
    insertVerb: 'INSERT OR REPLACE',
    columns: ['c'],
    ops: [op],
    deleteWhere: [{ column: 'partition_key', bindIndex: 0 }],
    ...extra,
  };
}

function evalOne(op: ShredOp, element: unknown, binds: (string | number | null)[] = []): unknown {
  return evalShredElement(specForOp(op), element, binds)?.c;
}

describe('evalShredElement — op semantics (the C++ shredder mirrors these exactly)', () => {
  it('bind: reads a scope value by index (null when out of range)', () => {
    expect(evalOne({ op: 'bind', index: 0 }, {}, ['week:nfl'])).toBe('week:nfl');
    expect(evalOne({ op: 'bind', index: 1 }, {}, ['a'])).toBeNull();
  });

  it('text: string-or-null (a non-string extract is null)', () => {
    expect(evalOne({ op: 'text', path: 'player.position' }, { player: { position: 'RB' } })).toBe('RB');
    expect(evalOne({ op: 'text', path: 'player.position' }, { player: { position: 5 } })).toBeNull();
    expect(evalOne({ op: 'text', path: 'player.position' }, {})).toBeNull();
  });

  it('int: number-or-null (no coercion of numeric strings)', () => {
    expect(evalOne({ op: 'int', path: 'years' }, { years: 0 })).toBe(0);
    expect(evalOne({ op: 'int', path: 'years' }, { years: '3' })).toBeNull();
    expect(evalOne({ op: 'int', path: 'years' }, {})).toBeNull();
  });

  it('real: null-or-Number(v)', () => {
    expect(evalOne({ op: 'real', path: 'stats.pass_yd' }, { stats: { pass_yd: 12 } })).toBe(12);
    expect(evalOne({ op: 'real', path: 'stats.pass_yd' }, { stats: {} })).toBeNull();
    expect(evalOne({ op: 'real', path: 'stats.pass_yd' }, {})).toBeNull();
  });

  it('real0: COALESCE(Number(v), 0)', () => {
    expect(evalOne({ op: 'real0', path: 'stats.pass_yd' }, { stats: { pass_yd: 12 } })).toBe(12);
    expect(evalOne({ op: 'real0', path: 'stats.pass_yd' }, {})).toBe(0);
  });

  it('real / real0: a value that is not a number lands as absent, because that is all simdjson can produce', () => {
    for (const bad of ['not a number', {}, [1, 2], '1e999']) {
      expect(evalOne({ op: 'real', path: 'stats.pass_yd' }, { stats: { pass_yd: bad } })).toBeNull();
      expect(evalOne({ op: 'real0', path: 'stats.pass_yd' }, { stats: { pass_yd: bad } })).toBe(0);
    }
  });

  it('real: keeps the coercions that do have a number in them, which is what separates this from `int`', () => {
    expect(evalOne({ op: 'real', path: 'stats.pass_yd' }, { stats: { pass_yd: '12.5' } })).toBe(12.5);
    expect(evalOne({ op: 'real', path: 'stats.pass_yd' }, { stats: { pass_yd: true } })).toBe(1);
  });

  it('metaText: null-or-String(v) (stringifies non-strings)', () => {
    expect(evalOne({ op: 'metaText', path: 'player.first_name' }, { player: { first_name: 'Pat' } })).toBe('Pat');
    expect(evalOne({ op: 'metaText', path: 'player.status' }, { player: { status: 5 } })).toBe('5');
    expect(evalOne({ op: 'metaText', path: 'player.status' }, {})).toBeNull();
  });

  it('coalesceText: first present value (String), null or "" when none', () => {
    expect(evalOne({ op: 'coalesceText', paths: ['team', 'player.team'] }, { player: { team: 'BUF' } })).toBe('BUF');
    expect(evalOne({ op: 'coalesceText', paths: ['team', 'player.team'] }, { team: 'KC', player: { team: 'BUF' } })).toBe('KC');
    expect(evalOne({ op: 'coalesceText', paths: ['team', 'player.team'] }, {})).toBeNull();
    expect(evalOne({ op: 'coalesceText', paths: ['player_id', 'player.player_id'], emptyDefault: true }, {})).toBe('');
    expect(evalOne({ op: 'coalesceText', paths: ['team', 'player.team'] }, { team: null, player: { team: 'BUF' } })).toBe('BUF');
  });

  it('concat: joins per-part coalesce (stringified, "" for absent) with the separator', () => {
    const op: ShredOp = {
      op: 'concat',
      sep: '_',
      parts: [{ paths: ['sport'] }, { paths: ['season'] }, { paths: ['player_id', 'player.player_id'] }],
    };
    expect(evalOne(op, { sport: 'nfl', season: 2024, player: { player_id: '77' } })).toBe('nfl_2024_77');
    expect(evalOne(op, { sport: 'nfl' })).toBe('nfl__');
  });

  it('rawJsonField: the field re-serialized, null when absent', () => {
    expect(evalOne({ op: 'rawJsonField', path: 'player.fantasy_positions' }, { player: { fantasy_positions: ['RB', 'WR'] } })).toBe('["RB","WR"]');
    expect(evalOne({ op: 'rawJsonField', path: 'player.fantasy_positions' }, { player: {} })).toBeNull();
  });

  it('rawJsonField: round-trips a nested object, which is what every reader of the column does with it', () => {
    // The native shredder writes simdjson's own slice of the document, so only the parsed value is contractual.
    const stats = { pass_yd: 250, rec: [1, 2], note: 'x' };
    expect(JSON.parse(evalOne({ op: 'rawJsonField', path: 'stats' }, { stats }) as string)).toEqual(stats);
  });
});

describe('evalShredElement — whereGuard', () => {
  const spec = specForOp({ op: 'bind', index: 0 }, { whereGuard: { paths: ['player_id', 'player.player_id'] } });

  it('keeps an element with a resolvable player id', () => {
    expect(evalShredElement(spec, { player_id: '1' }, ['p'])).toEqual({ c: 'p' });
    expect(evalShredElement(spec, { player: { player_id: '2' } }, ['p'])).toEqual({ c: 'p' });
  });

  it('drops an element with no / empty player id (first-present, empty string fails)', () => {
    expect(evalShredElement(spec, {}, ['p'])).toBeUndefined();
    expect(evalShredElement(spec, { player_id: '' }, ['p'])).toBeUndefined();
    expect(evalShredElement(spec, { player_id: '', player: { player_id: '9' } }, ['p'])).toBeUndefined();
  });
});

describe('evalShredSpec — array', () => {
  it('maps present elements and skips guard failures', () => {
    const spec = specForOp({ op: 'bind', index: 0 }, { whereGuard: { paths: ['player_id'] } });
    const rows = evalShredSpec(spec, [{ player_id: '1' }, {}, { player_id: '2' }], ['p']);
    expect(rows).toEqual([{ c: 'p' }, { c: 'p' }]);
  });
});
