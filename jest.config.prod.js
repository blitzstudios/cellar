// The whole suite with `__DEV__` false, so the release-build half of every dev guard runs.
const base = require('./jest.config');

module.exports = {
  ...base,
  setupFiles: ['./jest.setup.prod.js', ...base.setupFiles],
};
