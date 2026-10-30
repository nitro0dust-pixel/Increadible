module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/features/0[1-6]'],
  // Applies when Jest runs with --coverage, as CI does. Set just under the figures of 2026-10-30 (statements 96.73, branches 94.85,
  // functions 94.75, lines 97.94) so that a real drop fails the build. Raise these with the code; never lower them to get green.
  coverageThreshold: { global: { statements: 95, branches: 93, functions: 93, lines: 96 } },
  collectCoverageFrom: [
    'src/**/*.ts',
    'features/0[789]-*/src/**/*.ts',
  ],
};
