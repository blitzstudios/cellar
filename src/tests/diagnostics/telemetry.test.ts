import { devWarnings } from '../../testing/dev_mode';
import { resetOnceGuards } from '../../diagnostics/once_guard';
import { reportStoreDegradation } from '../../diagnostics/telemetry';
import { configureDataKernel, INERT_ERRORS } from '../../runtime';

describe('reportStoreDegradation', () => {
  let captureException: jest.Mock;
  let captureMessage: jest.Mock;
  let warn: jest.SpyInstance;
  let random: jest.SpyInstance;

  beforeEach(() => {
    resetOnceGuards();
    captureException = jest.fn();
    captureMessage = jest.fn();
    configureDataKernel({ errors: { captureException, captureMessage } });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Sampling is on by default, so every assertion about a report needs the dice fixed.
    random = jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    configureDataKernel({ errors: INERT_ERRORS });
    warn.mockRestore();
    random.mockRestore();
  });

  it('reports with a queryable tag and a per-site fingerprint', () => {
    const error = new Error('unsupported op on this build');
    reportStoreDegradation({ scope: 'row_table.native_shred.player_stats', context: 'shred fell back to JS', error, extra: { table: 'player_stats' } });

    expect(captureException).toHaveBeenCalledTimes(1);
    const [reported, ctx] = captureException.mock.calls[0];
    expect(reported).toBe(error);
    expect(ctx.tags).toEqual({ off_heap_degradation: 'row_table.native_shred.player_stats' });
    expect(ctx.fingerprint).toEqual(['off-heap-degradation', 'row_table.native_shred.player_stats']);
    expect(ctx.extra).toEqual({ context: 'shred fell back to JS', table: 'player_stats' });
  });

  it('reports each site once per session', () => {
    for (let index = 0; index < 5; index += 1) {
      reportStoreDegradation({ scope: 'row_table.native_shred.player_stats', context: 'shred fell back to JS', error: new Error(`attempt ${index}`) });
    }
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(devWarnings(1));
    expect(captureException.mock.calls[0][0].message).toBe('attempt 0');
  });

  it('dedups per site, not globally', () => {
    reportStoreDegradation({ scope: 'row_table.native_shred.player_stats', context: 'a' });
    reportStoreDegradation({ scope: 'row_table.native_shred.schedule', context: 'b' });
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it('synthesizes an Error when the thrown value is not one', () => {
    reportStoreDegradation({ scope: 'player_stats_store.flush', context: 'flush failed', error: 'a string throw' });
    const [reported] = captureException.mock.calls[0];
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toBe('player_stats_store.flush: flush failed');
  });

  it('does not throw when the host configured no reporter, and still says so where anyone can see it', () => {
    configureDataKernel({ errors: INERT_ERRORS });
    expect(() => reportStoreDegradation({ scope: 'row_table.native_shred.player', context: 'shred fell back to JS' })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(devWarnings(1));
  });

  describe('sampling', () => {
    it('drops the session the sample misses, so a fleet-wide cause cannot flood the quota', () => {
      random.mockReturnValue(0.5);
      reportStoreDegradation({ scope: 'row_table.native_shred.player_stats', context: 'shred fell back to JS', sampleRate: 0.01 });
      expect(captureException).not.toHaveBeenCalled();
    });

    it('still warns locally when the sample misses: development has no quota to protect', () => {
      random.mockReturnValue(0.5);
      reportStoreDegradation({ scope: 'row_table.native_shred.player_stats', context: 'shred fell back to JS', sampleRate: 0.01 });
      expect(warn).toHaveBeenCalledTimes(devWarnings(1));
    });

    it('marks the site seen even when the sample misses, so the rate is a share of sessions not of occurrences', () => {
      random.mockReturnValue(0.5);
      reportStoreDegradation({ scope: 'row_table.native_shred.player_stats', context: 'first', sampleRate: 0.01 });
      random.mockReturnValue(0);
      reportStoreDegradation({ scope: 'row_table.native_shred.player_stats', context: 'second', sampleRate: 0.01 });
      expect(captureException).not.toHaveBeenCalled();
    });

    it('reports every session by default, so a fallback that should be rare is not quietly thinned out', () => {
      random.mockReturnValue(0.999999);
      reportStoreDegradation({ scope: 'row_table.native_shred.player_stats', context: 'shred fell back to JS' });
      expect(captureException).toHaveBeenCalledTimes(1);
    });
  });

  describe('severity', () => {
    it("sends a chosen degradation as a message, not an exception on somebody's error budget", () => {
      reportStoreDegradation({ scope: 'off_heap_kill_switch.player', context: 'the kill switch disabled this store', severity: 'info', sampleRate: 1 });

      expect(captureException).not.toHaveBeenCalled();
      expect(captureMessage).toHaveBeenCalledTimes(1);
      const [message, ctx] = captureMessage.mock.calls[0];
      expect(message).toBe('off_heap_kill_switch.player: the kill switch disabled this store');
      expect(ctx.level).toBe('info');
      expect(ctx.fingerprint).toEqual(['off-heap-degradation', 'off_heap_kill_switch.player']);
    });

    it('defaults to an exception, so an unexpected fallback keeps its stack', () => {
      const error = new Error('no native module');
      reportStoreDegradation({ scope: 'row_table.native_shred.player', context: 'shred fell back to JS', error, sampleRate: 1 });
      expect(captureMessage).not.toHaveBeenCalled();
      expect(captureException).toHaveBeenCalledWith(error, expect.anything());
    });
  });
});
