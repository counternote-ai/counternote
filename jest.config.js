module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/*.test.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleNameMapper: {
    '^electron$': '<rootDir>/src/__mocks__/electron.ts',
    '^ffmpeg-static$': '<rootDir>/src/__mocks__/ffmpeg-static.ts',
  },
};
