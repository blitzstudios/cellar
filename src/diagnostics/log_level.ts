/**
 * How much the kernel says on the host's console. Telemetry is separate and unaffected: a report still reaches the
 * error sink whatever this is set to, because what a host shows a developer and what it collects from the field are
 * different questions.
 *
 * `error` by default rather than `info`, because most of what the advisory levels report cannot be acted on at the
 * call site — a read of a slice still primes its whole partition, and where the API offers nothing narrower there is
 * no remedy to reach for. Printed every launch those teach a reader to skip the channel, which costs the reports
 * that do matter.
 */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info';

/** Ascending, so a level shows everything at or below its own rank. */
const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3 };

let current: LogLevel = 'error';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function getLogLevel(): LogLevel {
  return current;
}

/** Whether a message of this level prints. `silent` is not askable: nothing is logged at it. */
export function shouldLog(level: Exclude<LogLevel, 'silent'>): boolean {
  return RANK[current] >= RANK[level];
}
