module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/features/0[1-6]'],
  collectCoverageFrom: [
    'src/**/*.ts',
    'features/0[789]-*/src/**/*.ts',
  ],
};
