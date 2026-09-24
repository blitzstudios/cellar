/**
 * Writes rows that arrive by socket push. Pushes are buffered per partition, deduplicated by id, and written in chunks
 * outside the render. A chunk that fails is queued again, unless a newer push with the same id arrived meanwhile.
 */

// The core package, not `@tanstack/react-query`: the same batcher, without pulling React DOM in behind it.
import { notifyManager } from '@tanstack/query-core';

import { chunkList, getOrCreate } from '../collections';
import { RowShape, RowTable } from '../table/types';
import { reportStoreDegradation } from '../diagnostics/telemetry';
import { ChangeSet, isUnchanged, NO_CHANGES, unionChanges } from '../table/change_set';

const DEFAULT_CHUNK = 250;
const DEFAULT_RETRY_DELAY_MS = 1000;

/** How {@link createPushIngest} writes a store's pushed items. */
export interface PushIngestConfig<Item, Row extends RowShape, Key> {
  /** The store's name, shown in warnings. */
  name: string;
  /** The table the rows are written to. */
  table: RowTable<Row>;
  /** The column values that pick out a partition's rows. */
  where: (key: Key) => Partial<Row>;
  /**
   * The id a pushed item is deduplicated by; of several queued items with one id, only the last is written. It must
   * differ for any two items that should both be written.
   */
  idOf: (item: Item) => string;
  /** Turns a partition's queued items into rows. */
  toRows: (key: Key, items: readonly Item[]) => Row[];
  /** Tells the partition's readers which units a write changed. Not called for a write that changed nothing. */
  bump: (key: Key, changes: ChangeSet) => void;
  /** Called for each partition a write changed, before its readers update, such as to drop the partition's ETag. */
  onWrite: (key: Key) => void;
  /** How many rows to write per transaction; 250 by default. */
  chunk?: number;
  /** How long to wait before retrying a failed write, in ms; 1000 by default. */
  retryDelayMs?: number;
}

/** A store's buffer for pushed items, created by {@link createPushIngest}. */
export interface PushIngest<Item, Key> {
  /** Queues one pushed item for the partition; queued items are written together shortly after. */
  queue: (key: Key, item: Item) => void;
  /**
   * Holds the partition's queued items until the returned function is called, then writes them. Used while a fetch
   * replaces the partition, as `fetch.holdWrites`. Holds can overlap, and calling the release twice is harmless.
   */
  hold: (key: Key) => () => void;
}

/**
 * Creates the buffer for a store whose rows arrive by socket push. A burst of pushes is written once per row rather than
 * once per push, and outside the render that received them, so readers update a frame after the write finishes.
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
