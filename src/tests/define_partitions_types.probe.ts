/** Type-level tests, run by `tsc`: each `@ts-expect-error` fails typecheck if its guarantee stops holding. */

import { definePartitions } from '../define_partitions';
import { createMemoryRowTable } from '../table/memory';
import { createVersionAtom } from '../reactivity/version_atom';
import { RowTableSchema } from '../table/types';

type Row = { sport: string; id: string };

const schema: RowTableSchema<Row> = { table: 'rows', columns: { sport: { type: 'TEXT' }, id: { type: 'TEXT' } }, primaryKey: ['id'] };
const table = createMemoryRowTable(schema);
const version = createVersionAtom('probe_version');

const byFields = definePartitions<Row, { sport: string }>({
  name: 'by_fields',
  table,
  version,
  key: { fields: ['sport'], where: ({ sport }) => ({ sport }) },
});

type Locator = { locator: { sport: string; week: number } };

const byRecord = definePartitions<Row, string, Locator, { sport: string; week: number }>({
  name: 'by_record',
  table,
  version,
  key: { of: (args) => args.locator, id: (part) => `${part.sport}:${part.week}`, where: (key) => ({ sport: key }) },
});

/** A key spelled by fields takes the fields a caller has so far, as its reads do. */
export const looseFields = () => {
  byFields.lifecycle.usePrime({ sport: undefined });
  byFields.lifecycle.usePrimeAndVersion({ sport: null });
};

/** A key computed from a record takes the record a caller has so far, which `key.of` answers `null` for. */
export const looseRecord = () => {
  byRecord.lifecycle.usePrime({ locator: { sport: 'nfl', week: 1 } });
  byRecord.lifecycle.usePrime({ locator: undefined });
  byRecord.lifecycle.usePrimeAndVersion(undefined);
};

/** Loose reaches the args' own fields, not through them: a record short of a field `key.of` reads is a mistake. */
export const strictWithinTheRecord = () => {
  // @ts-expect-error `week` is one of the fields this partition is addressed by
  byRecord.lifecycle.usePrimeAndVersion({ locator: { sport: 'nfl' } });
};
