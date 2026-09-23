module.exports = {
  verbose: true,
  moduleFileExtensions: ['js', 'jsx', 'json', 'ts', 'tsx'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        isolatedModules: true,
        tsconfig: { noImplicitAny: false, strictNullChecks: false },
      },
    ],
  },
  testMatch: ['<rootDir>/src/**/*.test.[jt]s'],
  setupFiles: ['./jest.setup.js'],
  setupFilesAfterEnv: ['./jest.setup.sqljs.ts'],
};
