/** Type-level tests, run by `tsc`: each `@ts-expect-error` fails typecheck if its guarantee stops holding. */

import { definePartitions } from '../../define_partitions';
import { createMemoryRowTable } from '../../table/memory';
import { createVersionAtom } from '../../reactivity/version_atom';
import { RowTableSchema } from '../../table/types';

type Row = { sport: string; team: string; id: string };
type Args = { sport: string; team?: string | null; ids?: readonly string[] };

const schema: RowTableSchema<Row> = {
  table: 'rows',
  columns: { sport: { type: 'TEXT' }, team: { type: 'TEXT' }, id: { type: 'TEXT' } },
  primaryKey: ['id'],
};

const rows = definePartitions<Row, { sport: string }, Args>({
  name: 'select_args_probe',
  table: createMemoryRowTable(schema),
  version: createVersionAtom('select_args_probe_version'),
  key: { fields: ['sport'], where: ({ sport }) => ({ sport }) },
});

/** A field named in `varyBy` arrives non-null, since the read is off until it does — so no cast at the call. */
export const declaredFieldsArrive = () =>
  rows.read<Args, string>()({
    varyBy: ['team'],
    select: (args) => args.team.toUpperCase(),
    empty: '',
  });

/** Everything else is out of reach: reading it is what would serve one caller's value to another. */
export const undeclaredFieldIsUnreachable = () =>
  rows.read<Args, string>()({
    varyBy: ['team'],
    // @ts-expect-error `ids` is not one of the fields this read declared it varies by
    select: (args) => args.ids.join(),
    empty: '',
  });

/** A read that varies by nothing has nothing to reach for; its partition key is the whole of what it gets. */
export const noVaryByReachesNothing = () =>
  rows.read<Args, string>()({
    // @ts-expect-error a read declaring no `varyBy` may read only its key
    select: (args) => args.team,
    empty: '',
  });

/** The same for a set read, which is handed its keys alongside. */
export const setReadsNarrowToo = () => {
  rows.readMany<Args, string>()({
    varyBy: ['ids'],
    partitions: (args) => [{ sport: args.sport }],
    select: (args, keys) => `${args.ids.length}:${keys.length}`,
    empty: '',
  });
  rows.readGrouped<Args, string>()({
    varyBy: ['team'],
    groups: (args) => [[{ sport: args.sport }]],
    // @ts-expect-error `ids` is not one of the fields this read declared it varies by
    select: (args, groups) => `${args.ids.length}:${groups.length}`,
    empty: '',
  });
};

/** A read computing its own vary values names no fields to narrow to, so it answers for the whole args itself. */
export const computedVaryByKeepsTheArgs = () =>
  rows.read<Args, string>()({
    varyBy: (args: Args) => [args.team, args.ids],
    select: (args) => `${args.sport}${args.team ?? ''}${args.ids?.length ?? 0}`,
    empty: '',
  });
