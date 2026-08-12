"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.reportStoreDegradation = reportStoreDegradation;
var _runtime = require("../runtime.js");
var _once_guard = require("./once_guard.js");
/**
 * The report an off-heap path files when it stays correct while losing the win it exists for, such as a native shred
 * that fell back to JS. Each site reports once per session, to the dev console and to Sentry.
 */

const reportedScopes = (0, _once_guard.createOnceGuard)();

/** Files one degradation, at most once per `scope` per session. */
function reportStoreDegradation(args) {
  const {
    scope,
    context,
    error,
    extra,
    severity = 'error',
    sampleRate = 1
  } = args;
  if (reportedScopes.seen(scope)) return;
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.warn(`[off-heap degraded] ${scope}: ${context}`, error ?? '', extra ?? '');
  }
  if (!(sampleRate >= 1) && Math.random() >= sampleRate) return;
  const sink = (0, _runtime.errorSink)();
  const captureContext = {
    tags: {
      off_heap_degradation: scope
    },
    fingerprint: ['off-heap-degradation', scope],
    extra: {
      context,
      ...extra
    }
  };
  if (severity === 'info') sink.captureMessage(`${scope}: ${context}`, {
    level: 'info',
    ...captureContext
  });else sink.captureException(error instanceof Error ? error : new Error(`${scope}: ${context}`), captureContext);
}
//# sourceMappingURL=telemetry.js.map