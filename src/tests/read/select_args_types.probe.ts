/** Type-level tests, run by `tsc`: each `@ts-expect-error` fails typecheck if its guarantee stops holding. */

import { definePartitions } from '../../define_partitions';
import { createMemoryRowTable } from '../../table/memory';
import { createVersionAtom } from '../../reactivity/version_atom';
import { RowTableSchema } from '../../table/types';

type Row = { region: string; cohort: string; id: string };
type Args = { region: string; cohort?: string | null; ids?: readonly string[] };

const schema: RowTableSchema<Row> = {
  table: 'rows',
  columns: { region: { type: 'TEXT' }, cohort: { type: 'TEXT' }, id: { type: 'TEXT' } },
  primaryKey: ['id'],
};

const rows = definePartitions<Row, { region: string }, Args>({
  name: 'select_args_probe',
  table: createMemoryRowTable(schema),
  version: createVersionAtom('select_args_probe_version'),
  key: { fields: ['region'], where: ({ region }) => ({ region }) },
});

/** A field named in `varyBy` arrives non-null, since the read is off until it does — so no cast at the call. */
export const declaredFieldsArrive = () =>
  rows.read<Args, string>()({
    varyBy: ['cohort'],
    prime: 'partition',
    select: (args) => args.cohort.toUpperCase(),
    empty: '',
  });

/** Everything else is out of reach: reading it is what would serve one caller's value to another. */
export const undeclaredFieldIsUnreachable = () =>
  rows.read<Args, string>()({
    varyBy: ['cohort'],
    prime: 'partition',
    // @ts-expect-error `ids` is not one of the fields this read declared it varies by
    select: (args) => args.ids.join(),
    empty: '',
  });

/** A read that varies by nothing has nothing to reach for; its partition key is the whole of what it gets. */
export const noVaryByReachesNothing = () =>
  rows.read<Args, string>()({
    // @ts-expect-error a read declaring no `varyBy` may read only its key
    select: (args) => args.cohort,
    empty: '',
  });

/** The same for a set read, which is handed its keys alongside. */
export const setReadsNarrowToo = () => {
  rows.readMany<Args, string>()({
    varyBy: ['ids'],
    prime: 'partition',
    partitions: (args) => [{ region: args.region }],
    select: (args, keys) => `${args.ids.length}:${keys.length}`,
    empty: '',
  });
  rows.readGrouped<Args, string>()({
    varyBy: ['cohort'],
    prime: 'partition',
    groups: (args) => [[{ region: args.region }]],
    // @ts-expect-error `ids` is not one of the fields this read declared it varies by
    select: (args, groups) => `${args.ids.length}:${groups.length}`,
    empty: '',
  });
};

/** A read computing its own vary values names no fields to narrow to, so it answers for the whole args itself. */
export const computedVaryByKeepsTheArgs = () =>
  rows.read<Args, string>()({
    varyBy: (args: Args) => [args.cohort, args.ids],
    prime: 'partition',
    select: (args) => `${args.region}${args.cohort ?? ''}${args.ids?.length ?? 0}`,
    empty: '',
  });

/**
 * A read that narrows within its partition has to say what it does about priming. It is the slice-of-a-partition
 * shape that makes the question worth forcing: the read selects a few rows and priming fetches every row the
 * partition holds, and only the author knows whether that trade is worth making.
 */
export const narrowingReadMustAnswerPriming = () =>
  // @ts-expect-error a read declaring a `varyBy` must declare `prime`
  rows.read<Args, string>()({
    varyBy: ['cohort'],
    select: (args) => args.cohort.toUpperCase(),
    empty: '',
  });

/** And a read that takes its partition whole is not asked, because for it priming is plainly the right thing. */
export const wholePartitionReadNeedNotAnswerPriming = () =>
  rows.read<Args, string>()({
    select: (_args, key) => key.region,
    empty: '',
  });

/** `false` is the other answer: read whatever the partition already holds, and never fetch it on this read's behalf. */
export const narrowingReadMayDeclineToPrime = () =>
  rows.read<Args, string>()({
    varyBy: ['cohort'],
    prime: false,
    select: (args) => args.cohort.toUpperCase(),
    empty: '',
  });
