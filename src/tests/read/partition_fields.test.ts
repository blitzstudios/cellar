import { partitionKeyOf, requiredFieldsOf, varyValuesOf } from '../../read/partition_fields';

type ScheduleArgs = { sport: string; season: string; seasonType: string; team: string };
type ScheduleKey = { sport: string; season: string; seasonType: string };

const ARGS: ScheduleArgs = { sport: 'nfl', season: '2025', seasonType: 'regular', team: 'SF' };

describe('partitionKeyOf', () => {
  it('picks one field into the key it spells, the common case', () => {
    expect(partitionKeyOf<ScheduleArgs, { sport: string }>(['sport'])(ARGS)).toEqual({ sport: 'nfl' });
  });

  it('picks several, dropping the args the partition is not named by', () => {
    expect(partitionKeyOf<ScheduleArgs, ScheduleKey>(['sport', 'season', 'seasonType'])(ARGS)).toEqual({
      sport: 'nfl',
      season: '2025',
      seasonType: 'regular',
    });
  });

  it('is order-independent, since the key is an object and only `toParts` puts it in an order', () => {
    const declared = partitionKeyOf<ScheduleArgs, ScheduleKey>(['seasonType', 'sport', 'season'])(ARGS);
    expect(declared).toEqual(partitionKeyOf<ScheduleArgs, ScheduleKey>(['sport', 'season', 'seasonType'])(ARGS));
  });

  it('passes a function through untouched, so a partition that must be registered still can be', () => {
    const compute = (args: ScheduleArgs): string => `registered:${args.sport}`;
    expect(partitionKeyOf<ScheduleArgs, string>(compute)).toBe(compute);
  });

  it('returns a fresh key per call, so a caller may keep or mutate it', () => {
    const keyOf = partitionKeyOf<ScheduleArgs, { sport: string }>(['sport']);
    expect(keyOf(ARGS)).not.toBe(keyOf(ARGS));
  });
});

describe('requiredFieldsOf', () => {
  it('joins the partition fields to the vary fields, in that order', () => {
    expect(requiredFieldsOf<ScheduleArgs, ScheduleKey>(['sport', 'season', 'seasonType'], ['team'])).toEqual(['sport', 'season', 'seasonType', 'team']);
  });

  it('is the partition fields alone for a read that varies by nothing', () => {
    expect(requiredFieldsOf<ScheduleArgs, ScheduleKey>(['sport', 'season', 'seasonType'], undefined)).toEqual(['sport', 'season', 'seasonType']);
  });

  it.each([
    ['the partition', (args: ScheduleArgs) => `registered:${args.sport}`, ['team'] as const],
    ['the vary', ['sport'] as const, (args: ScheduleArgs) => [args.team]],
  ])('has no list to give when %s is computed, so such a read is published with a mapper', (_label, partition, varyBy) => {
    expect(
      requiredFieldsOf<ScheduleArgs, string>(
        partition as Parameters<typeof requiredFieldsOf<ScheduleArgs, string>>[0],
        varyBy as Parameters<typeof requiredFieldsOf<ScheduleArgs, string>>[1],
      ),
    ).toBeUndefined();
  });
});

describe('varyValuesOf', () => {
  it('plucks one field and several, keeping a non-string value as it is', () => {
    expect(varyValuesOf<{ ids: readonly string[] }>(['ids'])({ ids: ['a', 'b'] })).toEqual([['a', 'b']]);
    expect(varyValuesOf<ScheduleArgs>(['team', 'season'])(ARGS)).toEqual(['SF', '2025']);
  });

  it('reads an absent field as undefined rather than skipping it, so the read counts as unresolved', () => {
    expect(varyValuesOf<{ position?: string }>(['position'])({})).toEqual([undefined]);
  });

  it('passes a function through untouched', () => {
    const compute = (args: ScheduleArgs): string[] => [args.team];
    expect(varyValuesOf<ScheduleArgs>(compute)).toBe(compute);
  });
});
