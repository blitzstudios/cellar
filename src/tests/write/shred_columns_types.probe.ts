/** Type-level tests, run by `tsc`: each `@ts-expect-error` fails typecheck if its guarantee stops holding. */

import { ColumnDef, RowTableSchema } from '../../table/types';
import { RowOf, ShredColumn, shredColumnDefs } from '../../write/shred_columns';

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

export const columns: RowTableSchema<Row>['columns'] = shredColumnDefs(COLUMNS);

// @ts-expect-error a name the table does not declare has no def, rather than an `any` one
export const notADef: ColumnDef = shredColumnDefs(COLUMNS).opponent;
