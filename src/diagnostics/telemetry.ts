/**
 * The report an off-heap path files when it stays correct while losing the win it exists for, such as a native shred
 * that fell back to JS. Each site reports once per session, to the dev console and to Sentry.
 */

import { errorSink } from '../runtime';
import { createOnceGuard } from './once_guard';

const reportedScopes = createOnceGuard();

/** Files one degradation, at most once per `scope` per session. */
export function reportStoreDegradation(args: {
  /** Stable, queryable site identifier, e.g. `row_table.native_shred.player_stats`. */
  scope: string;
  context: string;
  error?: unknown;
  extra?: Record<string, unknown>;
  severity?: 'error' | 'info';
  sampleRate?: number;
}): void {
  const { scope, context, error, extra, severity = 'error', sampleRate = 1 } = args;

  if (reportedScopes.seen(scope)) return;

  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.warn(`[off-heap degraded] ${scope}: ${context}`, error ?? '', extra ?? '');
  }

  if (!(sampleRate >= 1) && Math.random() >= sampleRate) return;

  const sink = errorSink();
  const captureContext = {
    tags: { off_heap_degradation: scope },
    fingerprint: ['off-heap-degradation', scope],
    extra: { context, ...extra },
  };

  if (severity === 'info') sink.captureMessage(`${scope}: ${context}`, { level: 'info', ...captureContext });
  else sink.captureException(error instanceof Error ? error : new Error(`${scope}: ${context}`), captureContext);
}
