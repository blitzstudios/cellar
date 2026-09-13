import type { Read } from '../../read/surface';
import { pairRead } from '../../read/facade';
import { makeResult } from '../../store_result';

describe('pairRead', () => {
  type Args = { region: string; cohort: string; ids: readonly string[] };

  /** A read as `definePartitions` publishes one: it carries the fields it waits on, which is the pair's whole gate. */
  const fakeRead = (requires: readonly string[] = ['region', 'cohort']) => {
    const calls: { get: unknown[]; use: unknown[] } = { get: [], use: [] };
    const read: Read<Args, string> = {
      getValue: (args) => {
        calls.get.push(args);
        return 'got';
      },
      useValue: (args, options) => {
        calls.use.push([args, options]);
        return makeResult('used', 'success');
      },
      requires,
    };
    return { read, calls };
  };

  it('hands both halves the fields the read says it needs, unchanged', () => {
    const { read, calls } = fakeRead();
    const pair = pairRead(() => read);

    pair.getValue({ params: { region: 'us', cohort: 'PHI' } });
    pair.useValue({ params: { region: 'us', cohort: 'PHI' } });

    expect(calls.get).toEqual([{ region: 'us', cohort: 'PHI' }]);
    expect(calls.use).toEqual([[{ region: 'us', cohort: 'PHI' }, undefined]]);
  });

  it('passes `options` to the hook half', () => {
    const { read, calls } = fakeRead();
    const pair = pairRead(() => read);

    pair.useValue({ params: { region: 'us', cohort: 'PHI' }, options: { enabled: false } });

    expect(calls.use).toEqual([[{ region: 'us', cohort: 'PHI' }, { enabled: false }]]);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
  ])('holds both halves inert while a required field is %s, rather than making the caller gate the call', (_label, absent) => {
    const { read, calls } = fakeRead();
    const pair = pairRead(() => read);

    pair.getValue({ params: { region: 'us', cohort: absent } });
    pair.useValue({ params: { region: 'us', cohort: absent } });

    expect(calls.get).toEqual([undefined]);
    expect(calls.use).toEqual([[undefined, undefined]]);
  });

  it.each([
    ['an empty array', [] as readonly string[]],
    ['zero', 0 as unknown as readonly string[]],
    ['false', false as unknown as readonly string[]],
  ])('counts %s as a field the caller has answered', (_label, answered) => {
    const { read, calls } = fakeRead(['ids']);
    const pair = pairRead(() => read);

    pair.getValue({ params: { ids: answered } });

    expect(calls.get).toEqual([{ ids: answered }]);
  });

  it('says so plainly when a read names nothing to gate on', () => {
    const { read } = fakeRead();
    const pair = pairRead(() => ({ ...read, requires: undefined }));

    expect(() => pair.getValue({ params: { region: 'us', cohort: 'PHI' } })).toThrow(/gate on nothing/);
  });

  it('resolves the read per call, so a backend swapped at runtime is picked up', () => {
    const first = fakeRead();
    const second = fakeRead();
    let current = first;
    const pair = pairRead(() => current.read);

    pair.getValue({ params: { region: 'us', cohort: '1' } });
    current = second;
    pair.getValue({ params: { region: 'us', cohort: '2' } });

    expect(first.calls.get).toEqual([{ region: 'us', cohort: '1' }]);
    expect(second.calls.get).toEqual([{ region: 'us', cohort: '2' }]);
  });
});
