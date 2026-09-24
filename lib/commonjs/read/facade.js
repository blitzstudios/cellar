"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.pairRead = pairRead;
/**
 * The types a store's service (its public API, such as `playerService`) is written with, and `pairRead`, which
 * publishes each of a store's reads as a hook and a getter taking one `{ params, options }` argument.
 */

/**
 * An id a caller may not have yet, such as a route param still loading. A published read accepts it as is, and returns
 * `empty` until it has a value (`undefined`, `null` and `''` count as not having one).
 */

/** The `options` part of a published read hook's argument, `{ params, options }`. */

/**
 * `T` with every field optional and nullable. A published read takes its params this way, so a caller can pass values
 * it may not have yet (`string | null | undefined`) as they are, and the read returns `empty` until they arrive.
 */

/**
 * A store read as a service publishes it (from {@link pairRead}): a hook for components and a getter for other code,
 * which return the same value. The hook is named with `use` so React Compiler treats it as a hook rather than
 * memoizing the call away.
 */

/**
 * A field has arrived once it holds something a caller could have meant: `undefined`, `null` and `''` are a caller
 * still waiting, while `[]`, `0` and `false` are answers, which the read's own `varyBy` then judges.
 */
const hasArrived = value => value !== undefined && value !== null && value !== '';

/**
 * Publishes a store read as a hook (`useValue`) and a getter (`getValue`) for a service's public API, each taking one
 * `{ params }` argument. `read` returns the read from the store, such as `() => playerStore.reads.byId`; it is called
 * on every use, so it always reaches the read built over the store's current database. The params are the read's args
 * with every field optional and nullable, and both return `empty` until every field in the read's
 * {@link Read.requires} has a value (`undefined`, `null` and `''` count as missing).
 *
 * The two return the same value but fetch differently. `useValue` fetches through React Query, and refetches when the
 * partition is older than its `staleTime`. `getValue` fetches only a partition that has never been fetched: a one-off
 * call has no component to refresh, and a getter called in a loop would otherwise flood the network.
 */
function pairRead(read) {
  /** Takes the read it is about to call, since `requires` belongs to the running table's copy of it. */
  const argsOf = (target, params) => {
    const {
      requires
    } = target;
    if (!requires) {
      throw new Error('pairRead: this read publishes no `requires`, so it has been asked to gate on nothing; name the fields a caller must have');
    }
    const fields = params;
    // Sound because params are the args loosely, and every field the read named is now in hand.
    return requires.every(field => hasArrived(fields[field])) ? params : undefined;
  };
  return {
    useValue: args => {
      const target = read();
      return target.useValue(argsOf(target, args.params), args.options);
    },
    getValue: args => {
      const target = read();
      return target.getValue(argsOf(target, args.params));
    }
  };
}
//# sourceMappingURL=facade.js.map