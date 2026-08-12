/**
 * Jest wrappers that pin a case to one build of the app: the store suites run twice, with `__DEV__` on under
 * `jest.config.js` and off under `jest.config.prod.js`.
 */
export declare const itDev: jest.It;
export declare const itProd: jest.It;
export declare const describeDev: jest.Describe;
/** `count` under `__DEV__`, 0 otherwise, for a warning tally asserted in both passes. */
export declare const devWarnings: (count: number) => number;
//# sourceMappingURL=dev_mode.d.ts.map