"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.itProd = exports.itDev = exports.devWarnings = exports.describeDev = void 0;
/**
 * Jest wrappers that pin a case to one build of the app: the store suites run twice, with `__DEV__` on under
 * `jest.config.js` and off under `jest.config.prod.js`.
 */

const itDev = exports.itDev = __DEV__ ? it : it.skip;
const itProd = exports.itProd = __DEV__ ? it.skip : it;
const describeDev = exports.describeDev = __DEV__ ? describe : describe.skip;

/** `count` under `__DEV__`, 0 otherwise, for a warning tally asserted in both passes. */
const devWarnings = count => __DEV__ ? count : 0;
exports.devWarnings = devWarnings;
//# sourceMappingURL=dev_mode.js.map