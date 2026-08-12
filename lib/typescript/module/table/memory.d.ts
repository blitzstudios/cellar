/** The row table held in JS `Map`s, which is the backend on web and in every test. */
import { RowShape, RowTable, RowTableSchema } from './types';
/**
 * The {@link RowTable} a store gets where the platform has no SQLite: the web build, every test, and the stretch before
 * a mobile store's connection is bound. Its rows sit on the JS heap, so it answers a read exactly as SQLite would and
 * saves none of the memory the off-heap design is for.
 */
export declare function createMemoryRowTable<Row extends RowShape>(schema: RowTableSchema<Row>): RowTable<Row>;
//# sourceMappingURL=memory.d.ts.map