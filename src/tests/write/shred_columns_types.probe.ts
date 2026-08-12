/** Type-level tests, run by `tsc`: each `@ts-expect-error` fails typecheck if its guarantee stops holding. */

import { ColumnDef, RowTableSchema } from '../../table/types';
import { defineShredColumns, RowOf, ShredColumn } from '../../write/shred_columns';
import { ShredOp } from '../../write/shred_spec';

/** `meta` is untyped on purpose: it is what makes an unannotated builder's return type `any`. */
type Game = { week: number; team: string; meta: any };

const COLUMNS = [
  { name: 'week', type: 'INTEGER', js: (game: Game) => game.week },
  { name: 'team', type: 'TEXT', notNull: true, js: (game: Game): string => game.team },
] as const satisfies readonly ShredColumn<Game>[];

type Row = RowOf<typeof COLUMNS>;

export const row: Row = { week: 1, team: 'SF' };

// @ts-expect-error `week`'s builder returns a number, so the row's field is a number too
export const wrongType: Row = { week: '1', team: 'SF' };

// @ts-expect-error a column the table does not declare is not a field of the row
export const notAColumn: string = row.opponent;

const UNANNOTATED = [{ name: 'note', type: 'TEXT', js: (game: Game) => game.meta.note }] as const satisfies readonly ShredColumn<Game>[];

declare const note: RowOf<typeof UNANNOTATED>['note'];

// @ts-expect-error `any` would have been assignable to anything here, which is the bug; the message type is not
export const unannotated: number = note;

const shred = defineShredColumns<Game>()(COLUMNS);

export const columns: RowTableSchema<Row>['columns'] = shred.columnDefs;

// @ts-expect-error a name the table does not declare has no def, rather than an `any` one
export const notADef: ColumnDef = shred.columnDefs.opponent;

/** The point of binding the columns: a built row is typed as the row they describe, so no ingest asserts its own. */
export const built: Row = shred.row({ week: 1, team: 'SF', meta: null });

// @ts-expect-error the row a bound table builds is not an untyped bag of columns
export const builtWrong: number = shred.row({ week: 1, team: 'SF', meta: null }).team;

/**
 * A table one column short of a native shred offers neither op member, so the store that would have got an exception
 * gets a compile error instead. `COLUMNS` above declares no `op` at all, which is `schedule`'s case.
 */
// @ts-expect-error a table whose columns do not all declare an `op` cannot bind a native shred
export const opsWithoutOps = shred.ops;

// @ts-expect-error and neither can it name them
export const namedOpsWithoutOps = shred.namedOps;

const SHREDDABLE = [
  { name: 'week', type: 'INTEGER', js: (game: Game) => game.week, op: { op: 'int', path: 'week' } },
  { name: 'team', type: 'TEXT', notNull: true, js: (game: Game): string => game.team, op: { op: 'text', path: 'team' } },
] as const satisfies readonly ShredColumn<Game>[];

const shreddable = defineShredColumns<Game>()(SHREDDABLE);

/** Once every column carries one, both are plain members — the same access as every other thing the table derives. */
export const ops: ShredOp[] = shreddable.ops;
export const namedOps: { name: string; op: ShredOp }[] = shreddable.namedOps;

const PARTLY_SHREDDABLE = [
  { name: 'week', type: 'INTEGER', js: (game: Game) => game.week, op: { op: 'int', path: 'week' } },
  { name: 'team', type: 'TEXT', notNull: true, js: (game: Game): string => game.team },
] as const satisfies readonly ShredColumn<Game>[];

const partly = defineShredColumns<Game>()(PARTLY_SHREDDABLE);

// @ts-expect-error one column short is still short: a bind order that skipped it would not match the columns
export const partialOps = partly.ops;
