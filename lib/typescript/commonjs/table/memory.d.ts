/** The row table held in JS `Map`s, which a store runs on on web and in every test. */
import { RowShape, RowTable, RowTableSchema } from './types';
/**
 * The {@link RowTable} a store gets where the platform has no SQLite: the web build, every test, a store whose SQLite
 * never bound, and one that lost it mid-session. It answers a read exactly as SQLite would, and like SQLite it finds
 * rows through the schema's primary key and indexes rather than by scanning, so a read of one player costs the same
 * whether the table holds one partition or fifty. It holds the rows on the JS heap, so it saves none of the memory the
 * off-heap design is for, and it neither stores nor compares a `sqliteOnly` column.
 */
export declare function createMemoryRowTable<Row extends RowShape>(schema: RowTableSchema<Row>): RowTable<Row>;
//# sourceMappingURL=memory.d.ts.map