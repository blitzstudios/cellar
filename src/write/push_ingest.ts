/**
 * The write path for rows that arrive by socket push: buffered per partition, deduped by id, and written in bounded
 * chunks off the render path. A failed chunk is requeued behind any newer push under the same id.
 */

// The core package, not `@tanstack/react-query`: the same batcher, without pulling React DOM in behind it.
import { notifyManager } from '@tanstack/query-core';

import { chunkList, getOrCreate } from '../collections';
import { RowShape, RowTable } from '../table/types';
import { reportStoreDegradation } from '../diagnostics/telemetry';
import { ChangeSet, isUnchanged, NO_CHANGES, unionChanges } from '../table/change_set';

const DEFAULT_CHUNK = 250;
const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * What a socket-fed store hands the buffer so it can write on the store's behalf: where a partition's rows live, what
 * identifies one pushed item, how items become rows, and the bump and post-write hook a landed write runs. `idOf` has
 * to separate two rows that can both be in flight, since a flush keeps only the last item queued under an id.
 */
export interface PushIngestConfig<Item, Row extends RowShape, Key> {
  name: string;
  table: RowTable<Row>;
  where: (key: Key) => Partial<Row>;
  idOf: (item: Item) => string;
  toRows: (key: Key, items: readonly Item[]) => Row[];
  /** Bumps a partition with the units a flush changed in it. Never called for a flush that changed nothing there. */
  bump: (key: Key, changes: ChangeSet) => void;
  /** Runs for each partition a write changed, before its readers wake; a store keeping an ETag retires it here. */
  onWrite: (key: Key) => void;
  chunk?: number;
  retryDelayMs?: number;
}

/**
 * The two ways a store drives its push buffer: `queue` for each item off the socket, and `hold` for a partition a fetch
 * is about to delete and rewrite — which is what a partition's `fetch.holdWrites` wants.
 */
export interface PushIngest<Item, Key> {
  queue: (key: Key, item: Item) => void;
  /** Buffers the partition's pushes until the returned release flushes them. Reference-counted and idempotent. */
  hold: (key: Key) => () => void;
}

/**
 * Builds the write path for a store whose rows arrive by socket, which is what its `write/live_ingest.ts` stages frames
 * into: a burst of frames costs one write per row rather than one per frame, and none of it runs on the frame the push
 * arrived. Readers wake a frame after a write resolves, which is the trade for keeping the work off the render path.
 */
export function createPushIngest<Item, Row extends RowShape, Key>(config: PushIngestConfig<Item, Row, Key>): PushIngest<Item, Key> {
  const { name, table, where, idOf, toRows, bump, onWrite } = config;
  const chunk = config.chunk ?? DEFAULT_CHUNK;
  const retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  const held = new Map<Key, number>();
  const pending = new Map<Key, Map<string, Item>>();
  let flushScheduled = false;
  let flushing = false;

  function scheduleFlush(delayMs = 0): void {
    if (flushScheduled || flushing) return;
    flushScheduled = true;
    setTimeout(() => {
      flushScheduled = false;
      runFlush().catch((error) => {
        reportStoreDegradation({
          scope: `${name}.flush_aborted`,
          context: 'the push flush threw outside the write, leaving the partitions it had not reached unbumped and their readers stale until the next flush',
          error,
        });
      });
    }, delayMs);
  }

  const bufferFor = (key: Key): Map<string, Item> => getOrCreate(pending, key, () => new Map<string, Item>());

  /** Returns items to the buffer, keeping whatever newer push already sits under the same id. */
  function requeue(key: Key, items: readonly Item[]): void {
    const bucket = bufferFor(key);
    for (const item of items) {
      const id = idOf(item);
      if (!bucket.has(id)) bucket.set(id, item);
    }
  }

  async function runFlush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    let failed = false;
    try {
      while (pending.size) {
        const partitions = Array.from(pending.entries()).filter(([key]) => !held.has(key));
        // A held partition stays pending; its release is what schedules the flush that finally writes it.
        if (!partitions.length) break;
        partitions.forEach(([key]) => pending.delete(key));
        const touched: Array<[Key, ChangeSet]> = [];
        for (let index = 0; index < partitions.length; index += 1) {
          const [key, byId] = partitions[index];
          const items = Array.from(byId.values());
          const batches = chunkList(items, chunk);
          let changes: ChangeSet = NO_CHANGES;
          let written = 0;
          for (const batch of batches) {
            const rows = toRows(key, batch);
            if (rows.length) {
              try {
                // eslint-disable-next-line no-await-in-loop -- sequential by design: bound the JS thread per frame
                const result = await table.upsert(rows, { chunk });
                changes = unionChanges(changes, result.changes);
              } catch (error) {
                const unwritten = items.slice(written);
                requeue(key, unwritten);
                reportStoreDegradation({
                  scope: `${name}.flush`,
                  context: 'a batch of pushed rows failed to persist; it is requeued and retried after a delay',
                  error,
                  extra: { partitionKey: String(key), rowCount: rows.length, requeued: unwritten.length },
                });
                failed = true;
                break;
              }
            }
            written += batch.length;
          }
          // Only where rows changed: a push repeating what the table holds, or filtering down to nothing, wakes nobody.
          if (!isUnchanged(changes)) touched.push([key, changes]);
          if (failed) {
            for (let rest = index + 1; rest < partitions.length; rest += 1) {
              requeue(partitions[rest][0], Array.from(partitions[rest][1].values()));
            }
            break;
          }
        }

        if (touched.length) {
          for (const [key] of touched) onWrite(key);
          // Batched so a flush that touched several partitions wakes each listener once.
          notifyManager.batch(() => {
            for (const [key, changes] of touched) bump(key, changes);
          });
        }
        if (failed) break;
      }
    } finally {
      flushing = false;
      // Rows waiting on a hold are the release's to schedule.
      const writable = Array.from(pending.keys()).some((key) => !held.has(key));
      if (writable) scheduleFlush(failed ? retryDelayMs : 0);
    }
  }

  function hold(key: Key): () => void {
    held.set(key, (held.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const depth = (held.get(key) ?? 1) - 1;
      if (depth > 0) held.set(key, depth);
      else held.delete(key);
      if (!held.has(key)) scheduleFlush();
    };
  }

  function queue(key: Key, item: Item): void {
    bufferFor(key).set(idOf(item), item);
    scheduleFlush();
  }

  return { queue, hold };
}
