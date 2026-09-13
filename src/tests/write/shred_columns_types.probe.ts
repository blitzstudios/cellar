/** Type-level tests, run by `tsc`: each `@ts-expect-error` fails typecheck if its guarantee stops holding. */

import { ColumnDef, RowTableSchema } from '../../table/types';
import { defineShredColumns, RowOf, ShredColumn } from '../../write/shred_columns';
import { ShredOp } from '../../write/shred_spec';

/** `meta` is untyped on purpose: it is what makes an unannotated builder's return type `any`. */
type Event = { week: number; cohort: string; meta: any };

const COLUMNS = [
  { name: 'week', type: 'INTEGER', js: (event: Event) => event.week },
  { name: 'cohort', type: 'TEXT', notNull: true, js: (event: Event): string => event.cohort },
] as const satisfies readonly ShredColumn<Event>[];

type Row = RowOf<typeof COLUMNS>;

export const row: Row = { week: 1, cohort: 'SF' };

// @ts-expect-error `week`'s builder returns a number, so the row's field is a number too
export const wrongType: Row = { week: '1', cohort: 'SF' };

// @ts-expect-error a column the table does not declare is not a field of the row
export const notAColumn: string = row.opponent;

const UNANNOTATED = [{ name: 'note', type: 'TEXT', js: (event: Event) => event.meta.note }] as const satisfies readonly ShredColumn<Event>[];

declare const note: RowOf<typeof UNANNOTATED>['note'];

// @ts-expect-error `any` would have been assignable to anything here, which is the bug; the message type is not
export const unannotated: number = note;

const shred = defineShredColumns<Event>()(COLUMNS);

export const columns: RowTableSchema<Row>['columns'] = shred.columnDefs;

// @ts-expect-error a name the table does not declare has no def, rather than an `any` one
export const notADef: ColumnDef = shred.columnDefs.opponent;

/** The point of binding the columns: a built row is typed as the row they describe, so no ingest asserts its own. */
export const built: Row = shred.row({ week: 1, cohort: 'SF', meta: null });

// @ts-expect-error the row a bound table builds is not an untyped bag of columns
export const builtWrong: number = shred.row({ week: 1, cohort: 'SF', meta: null }).cohort;

/**
 * A table one column short of a native shred offers neither op member, so the store that would have got an exception
 * gets a compile error instead. `COLUMNS` above declares no `op` at all, which is `schedule`'s case.
 */
// @ts-expect-error a table whose columns do not all declare an `op` cannot bind a native shred
export const opsWithoutOps = shred.ops;

// @ts-expect-error and neither can it name them
export const namedOpsWithoutOps = shred.namedOps;

const SHREDDABLE = [
  { name: 'week', type: 'INTEGER', js: (event: Event) => event.week, op: { op: 'int', path: 'week' } },
  { name: 'cohort', type: 'TEXT', notNull: true, js: (event: Event): string => event.cohort, op: { op: 'text', path: 'cohort' } },
] as const satisfies readonly ShredColumn<Event>[];

const shreddable = defineShredColumns<Event>()(SHREDDABLE);

/** Once every column carries one, both are plain members — the same access as every other thing the table derives. */
export const ops: ShredOp[] = shreddable.ops;
export const namedOps: { name: string; op: ShredOp }[] = shreddable.namedOps;

const PARTLY_SHREDDABLE = [
  { name: 'week', type: 'INTEGER', js: (event: Event) => event.week, op: { op: 'int', path: 'week' } },
  { name: 'cohort', type: 'TEXT', notNull: true, js: (event: Event): string => event.cohort },
] as const satisfies readonly ShredColumn<Event>[];

const partly = defineShredColumns<Event>()(PARTLY_SHREDDABLE);

// @ts-expect-error one column short is still short: a bind order that skipped it would not match the columns
export const partialOps = partly.ops;
