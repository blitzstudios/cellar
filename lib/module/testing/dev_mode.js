"use strict";

/**
 * Jest wrappers that pin a case to one build of the app: the store suites run twice, with `__DEV__` on under
 * `jest.config.js` and off under `jest.config.prod.js`.
 */

export const itDev = __DEV__ ? it : it.skip;
export const itProd = __DEV__ ? it.skip : it;
export const describeDev = __DEV__ ? describe : describe.skip;

/** `count` under `__DEV__`, 0 otherwise, for a warning tally asserted in both passes. */
export const devWarnings = count => __DEV__ ? count : 0;
//# sourceMappingURL=dev_mode.js.map