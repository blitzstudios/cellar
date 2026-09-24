/**
 * Writes rows that arrive by socket push. Pushes are buffered per partition, deduplicated by id, and written in chunks
 * outside the render. A chunk that fails is queued again, unless a newer push with the same id arrived meanwhile.
 */
import { RowShape, RowTable } from '../table/types';
import { ChangeSet } from '../table/change_set';
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
export declare function createPushIngest<Item, Row extends RowShape, Key>(config: PushIngestConfig<Item, Row, Key>): PushIngest<Item, Key>;
//# sourceMappingURL=push_ingest.d.ts.map