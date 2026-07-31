import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript source during tests, so a test
// run never depends on a prior build. Plain `node` still gets dist/ via the
// default export condition.
const sourceCondition = ['iris:source'];

export default defineConfig({
  resolve: { conditions: sourceCondition },
  ssr: {
    resolve: {
      conditions: sourceCondition,
      externalConditions: sourceCondition,
    },
  },
  test: {
    // Source only. `tsc --build` also emits compiled copies of the test files
    // into each package's dist/, and without this every test runs twice — once
    // from src and once from a build artifact that may be stale. A green run
    // against a stale dist while src is broken is worse than a slow one.
    include: ['src/**/*.test.ts'],
    exclude: ['**/dist/**', '**/node_modules/**'],
    projects: [
      { extends: true, test: { name: 'domain', root: './packages/domain', environment: 'node' } },
      {
        extends: true,
        test: { name: 'adapters', root: './packages/adapters', environment: 'node' },
      },
      { extends: true, test: { name: 'api', root: './apps/api', environment: 'node' } },
      { extends: true, test: { name: 'web', root: './apps/web', environment: 'node' } },
      { extends: true, test: { name: 'e2e', root: './tests/e2e', environment: 'node' } },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['{apps,packages}/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/dist/**', '**/index.ts'],
    },
  },
});
