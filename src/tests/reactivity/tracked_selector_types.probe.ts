/** Type-level tests, run by `tsc`: each `@ts-expect-error` fails typecheck if its guarantee stops holding. */

import { createTrackedSelector } from '../../reactivity/tracked_selector';

type State = { round: number };

const round = (state: State, _id: string): number => state.round;
const id = (_state: State, playerId: string): string => playerId;

export const ok = createTrackedSelector([round, id], (round, ids) => `${round}:${ids.length}`);

export const okCall: string = ok({ round: 1 }, 'x');

// @ts-expect-error the selector's args come from the inputs, so a wrong one is caught here
export const badArg = ok({ round: 1 }, 5);

// @ts-expect-error `resultFn` receives the input values in order; swapping two of different types is not that
export const swapped = createTrackedSelector([round, id], (ids: string, round: number) => `${ids}${round}`);

// @ts-expect-error an input value cannot be used as a type it isn't
export const wrongUse = createTrackedSelector([round, id], (round, ids) => round.toUpperCase() + ids);

// @ts-expect-error arity is part of it: a `resultFn` parameter with no input to fill it would just be `undefined`
export const extraParam = createTrackedSelector([round], (round: number, notSupplied: string) => `${round}${notSupplied}`);
