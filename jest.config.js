module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  moduleNameMapper: {
    '^electron$': '<rootDir>/src/__mocks__/electron.ts',
    '^@/(.*)$': '<rootDir>/src/renderer/$1',
    '\\.(css)$': '<rootDir>/src/__mocks__/style.ts',
  },
};
