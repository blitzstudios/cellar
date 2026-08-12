// React Native provides `__DEV__` as a global; Node does not, and source that guards on a bare `__DEV__` throws.
// Only a default: `jest.setup.prod.js` sets it false first.
if (typeof global.__DEV__ === 'undefined') global.__DEV__ = true;
