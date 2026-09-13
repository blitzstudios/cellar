/**
 * The report an off-heap path files when it stays correct while losing the win it exists for, such as a native shred
 * that fell back to JS. Each site reports once per session, to the dev console and to Sentry. `severity: 'info'` files
 * the other kind: something expected that a reader of the same channel should not mistake for a fault.
 */
/** Files one degradation, at most once per `scope` per session. */
export declare function reportStoreDegradation(args: {
    /** Stable, queryable site identifier, e.g. `row_table.native_shred.<store>`. */
    scope: string;
    context: string;
    error?: unknown;
    extra?: Record<string, unknown>;
    severity?: 'error' | 'info';
    sampleRate?: number;
}): void;
//# sourceMappingURL=telemetry.d.ts.map