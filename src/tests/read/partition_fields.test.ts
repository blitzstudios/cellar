import { partitionKeyOf, requiredFieldsOf, varyValuesOf } from '../../read/partition_fields';

type ScheduleArgs = { region: string; year: string; itemType: string; cohort: string };
type CatalogKey = { region: string; year: string; itemType: string };

const ARGS: ScheduleArgs = { region: 'us', year: '2025', itemType: 'regular', cohort: 'SF' };

describe('partitionKeyOf', () => {
  it('picks one field into the key it spells, the common case', () => {
    expect(partitionKeyOf<ScheduleArgs, { region: string }>(['region'])(ARGS)).toEqual({ region: 'us' });
  });

  it('picks several, dropping the args the partition is not named by', () => {
    expect(partitionKeyOf<ScheduleArgs, CatalogKey>(['region', 'year', 'itemType'])(ARGS)).toEqual({
      region: 'us',
      year: '2025',
      itemType: 'regular',
    });
  });

  it('is order-independent, since the key is an object and only `toParts` puts it in an order', () => {
    const declared = partitionKeyOf<ScheduleArgs, CatalogKey>(['itemType', 'region', 'year'])(ARGS);
    expect(declared).toEqual(partitionKeyOf<ScheduleArgs, CatalogKey>(['region', 'year', 'itemType'])(ARGS));
  });

  it('passes a function through untouched, so a partition that must be registered still can be', () => {
    const compute = (args: ScheduleArgs): string => `registered:${args.region}`;
    expect(partitionKeyOf<ScheduleArgs, string>(compute)).toBe(compute);
  });

  it('returns a fresh key per call, so a caller may keep or mutate it', () => {
    const keyOf = partitionKeyOf<ScheduleArgs, { region: string }>(['region']);
    expect(keyOf(ARGS)).not.toBe(keyOf(ARGS));
  });
});

describe('requiredFieldsOf', () => {
  it('joins the partition fields to the vary fields, in that order', () => {
    expect(requiredFieldsOf<ScheduleArgs, CatalogKey>(['region', 'year', 'itemType'], ['cohort'])).toEqual(['region', 'year', 'itemType', 'cohort']);
  });

  it('is the partition fields alone for a read that varies by nothing', () => {
    expect(requiredFieldsOf<ScheduleArgs, CatalogKey>(['region', 'year', 'itemType'], undefined)).toEqual(['region', 'year', 'itemType']);
  });

  it.each([
    ['the partition', (args: ScheduleArgs) => `registered:${args.region}`, ['cohort'] as const],
    ['the vary', ['region'] as const, (args: ScheduleArgs) => [args.cohort]],
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
    expect(varyValuesOf<ScheduleArgs>(['cohort', 'year'])(ARGS)).toEqual(['SF', '2025']);
  });

  it('reads an absent field as undefined rather than skipping it, so the read counts as unresolved', () => {
    expect(varyValuesOf<{ position?: string }>(['position'])({})).toEqual([undefined]);
  });

  it('passes a function through untouched', () => {
    const compute = (args: ScheduleArgs): string[] => [args.cohort];
    expect(varyValuesOf<ScheduleArgs>(compute)).toBe(compute);
  });
});
