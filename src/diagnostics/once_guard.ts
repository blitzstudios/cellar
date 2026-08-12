/** Fire-once dedup. Every guard registers itself here, so {@link resetOnceGuards} re-arms all of them at once. */

const resets: Array<() => void> = [];

interface OnceGuard {
  /** Whether `key` was already marked, marking it if not. */
  seen(key: string): boolean;
  /** A read-only test of `key`'s mark. */
  has(key: string): boolean;
}

/**
 * A set of keys that can each be marked once, for a warning or a degradation report that would otherwise fire on every
 * call — a per-render DEV warning, or a Sentry report from a path a socket runs thousands of times.
 */
export function createOnceGuard(): OnceGuard {
  const marked = new Set<string>();
  resets.push(() => marked.clear());
  return {
    seen(key) {
      if (marked.has(key)) return true;
      marked.add(key);
      return false;
    },
    has: (key) => marked.has(key),
  };
}

/**
 * Enrols other state in that same reset, for a module whose warning carries something beside its guard — a batch it is
 * accumulating over a tick, say. Without this a reset re-arms the guard and leaves the state it was warning about.
 */
export function onGuardReset(reset: () => void): void {
  resets.push(reset);
}

/**
 * Re-arms every guard in the process. Marks outlive a test, so a test asserting that something warns calls this first,
 * or it passes or fails on whichever test ran before it.
 */
export function resetOnceGuards(): void {
  for (const reset of resets) reset();
}
