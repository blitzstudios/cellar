"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.pairRead = pairRead;
/**
 * What a store service's public surface is written against: the small types its methods are spelled in, and the
 * reactive/imperative pair each read is published as.
 */

/** An id a caller may not have yet. A read accepts it as is, and returns `empty` until it has a value. */

/** The `options` part of a published read's argument, `{ params, options }`. */

/** `T` with every field optional and nullable, so a caller can pass its own `string | null | undefined` as is. */

/**
 * A read as a service publishes it: a hook for components and a getter for other code. The hook is named with `use`
 * so React Compiler treats it as a hook rather than memoizing the call away.
 */

/**
 * A field has arrived once it holds something a caller could have meant: `undefined`, `null` and `''` are a caller
 * still waiting, while `[]`, `0` and `false` are answers, which the read's own `varyBy` then judges.
 */
const hasArrived = value => value !== undefined && value !== null && value !== '';

/**
 * Publishes a store read as a hook and a getter, for a service's public API. `read` returns the read from the store,
 * and is called on every use so it always reaches the store's current table. Params are the read's args with every
 * field optional; the read returns `empty` until every field in its {@link Read.requires} has a value.
 *
 * The two return the same value but fetch differently. `useValue` fetches through React Query and refetches when the
 * data goes stale; `getValue` only fetches a partition that has never been fetched, since a one-off call has nothing
 * to refetch for, and a getter called in a loop would otherwise flood the network.
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