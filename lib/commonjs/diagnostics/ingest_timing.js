"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.clearIngestTimings = clearIngestTimings;
exports.getIngestTimings = getIngestTimings;
exports.recordIngestTiming = recordIngestTiming;
exports.rollupIngestTimings = rollupIngestTimings;
/** A bounded ring of what the recent fetch-fed ingests cost, each split into network wait and shred. */

const CAPACITY = 128;

/**
 * One partition's fetch, as the diagnostics dump reports it: how long the request took against how long the shred did,
 * with the body's size and the row count to read them against. This is what says whether a slow load was the network
 * or the ingest.
 */

/** One store's share of the recorded ingests, totalled: which store a session spent its fetch and shred time in. */

const ring = [];

/** Files one ingest in the ring, which the fetch does for every partition it lands, 304s included. */
function recordIngestTiming(timing) {
  ring.push(timing);
  if (ring.length > CAPACITY) ring.shift();
}

/**
 * The ingests still in the ring, oldest first, for a caller that wants them one by one — the developer overlay's
 * diagnostics dump takes them this way and rolls them up beside it. The ring keeps only the most recent, so a dump
 * taken deep into a session no longer holds the launch's.
 */
function getIngestTimings() {
  return ring.slice();
}

/** Empties the ring, so what a measurement or a test reads back is only what it caused. */
function clearIngestTimings() {
  ring.length = 0;
}
const totalMs = roll => roll.fetchMs + roll.ingestMs;

/**
 * The recorded ingests totalled per store, costliest first — the summary to read before the individual timings, since
 * it names which store to look at. 304s count as fetches and carry no rows, so they show as time spent for nothing new.
 */
function rollupIngestTimings(timings = ring) {
  const byStore = new Map();
  for (const timing of timings) {
    const roll = byStore.get(timing.store) ?? {
      store: timing.store,
      fetches: 0,
      fetchMs: 0,
      ingestMs: 0,
      chars: 0,
      rows: 0
    };
    roll.fetches += 1;
    roll.fetchMs += timing.fetchMs;
    roll.ingestMs += timing.ingestMs;
    roll.chars += timing.chars ?? 0;
    if (timing.rows > 0) roll.rows += timing.rows;
    byStore.set(timing.store, roll);
  }
  return [...byStore.values()].sort((left, right) => totalMs(right) - totalMs(left));
}
//# sourceMappingURL=ingest_timing.js.map