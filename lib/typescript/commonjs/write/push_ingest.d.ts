/**
 * The write path for rows that arrive by socket push: buffered per partition, deduped by id, and written in bounded
 * chunks off the render path. A failed chunk is requeued behind any newer push under the same id.
 */
import { RowShape, RowTable } from '../table/types';
import { ChangeSet } from '../table/change_set';
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
export declare function createPushIngest<Item, Row extends RowShape, Key>(config: PushIngestConfig<Item, Row, Key>): PushIngest<Item, Key>;
//# sourceMappingURL=push_ingest.d.ts.map