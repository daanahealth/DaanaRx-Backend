/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
  // @daana-health/inventory-core ships ESM-only. Until the platform repo
  // adds a CJS build, redirect the bare-specifier import to the package's
  // TypeScript sources and let ts-jest transform them on the fly.
  moduleNameMapper: {
    '^@daana-health/inventory-core$':
      '<rootDir>/node_modules/@daana-health/inventory-core/src/index.ts',
    // The source files use Node-style ESM imports with `.js` extensions
    // (e.g. `from "./status.js"`). Rewrite those to extension-less so the
    // CJS-mode jest resolver finds the .ts siblings.
    '^(\\./.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { isolatedModules: true }],
  },
};
