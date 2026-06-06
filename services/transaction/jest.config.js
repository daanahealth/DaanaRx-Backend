/**
 * Jest config for the transaction service.
 *
 * Notes:
 *  - We borrow jest/ts-jest from the repo root (DaanaRx-Backend/node_modules)
 *    rather than adding deps to this service. The CLI is invoked from the
 *    repo root via:
 *      cd DaanaRx-Backend && npx jest --config services/transaction/jest.config.js
 *
 *  - @daana-health/inventory-core is published as ESM-only ("type":"module").
 *    We redirect imports of it to the package's TypeScript source files via
 *    moduleNameMapper so ts-jest transpiles them inline. This avoids modifying
 *    inventory-core's package.json (outside our scope).
 */
const path = require('path');

const corePkg = path.resolve(
  __dirname,
  '../../../daana-inventory/packages/inventory-core/src',
);

module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  preset: 'ts-jest',
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@daana-health/inventory-core$': `${corePkg}/index.ts`,
    // The core's own internal imports use `.js` suffix (ESM). Map them to .ts.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2020',
          module: 'commonjs',
          esModuleInterop: true,
          strict: false,
          skipLibCheck: true,
          resolveJsonModule: true,
        },
        diagnostics: false,
      },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!@daana-health/inventory-core)'],
  globals: {},
};
