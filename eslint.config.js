// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier/flat';

export default defineConfig([
  globalIgnores(['**/dist/', '**/coverage/', '**/*.min.js', 'supabase/.temp/']),

  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts,tsx}'],
    extends: [js.configs.recommended],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },

  {
    files: ['**/*.{ts,mts,cts,tsx}'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level config files that belong to no package tsconfig.
          allowDefaultProject: ['*.js', '*.ts', '*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // packages/domain is pure: deterministic, no I/O, no clock, no network.
  // CLAUDE.md makes this an architecture invariant, so it is enforced by the
  // linter rather than left to reviewer discipline.
  {
    basePath: 'packages/domain',
    files: ['**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'crypto', 'child_process'],
              message:
                'packages/domain must stay pure — no I/O. Put platform access in packages/adapters or apps/api.',
            },
            {
              group: ['@supabase/*'],
              message:
                'packages/domain must not depend on the database. Keep persistence in apps/api.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message:
            'Inject time into the domain instead of reading the clock — it must stay deterministic.',
        },
        { name: 'fetch', message: 'packages/domain must stay pure — no network access.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            'Inject time into the domain instead of reading the clock — it must stay deterministic.',
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'packages/domain must stay deterministic — inject randomness instead.',
        },
      ],
    },
  },

  // Tests may be looser: non-null assertions and fixture shapes are fine.
  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  // Must stay last: turns off everything Prettier owns.
  prettier,
]);
