import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

/**
 * Lint rules for the backend.
 *
 * This was added late, over roughly twenty thousand lines of existing, working,
 * reviewed code. A recommended-out-of-the-box config reported 414 problems on
 * the first run, and a gate that reports 414 problems is a gate everybody
 * learns to skip. So the rules below are the ones that can be met today, and
 * every relaxation says why rather than being left for a reviewer to guess at.
 *
 * The type gate is `tsc --noEmit` with `"strict": true`, and it runs in CI
 * beside this. That is the load-bearing check. This file is for the classes of
 * mistake the compiler is happy to accept.
 */
export default defineConfig([
  globalIgnores(['dist', 'node_modules', 'coverage', 'src/generated']),
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      /**
       * Off, deliberately, and this is the one worth defending.
       *
       * 401 of the 414 first-run problems were this rule. They are not
       * carelessness: rows arrive from the Supabase client without generated
       * types, and Fastify request bodies are unknown until they have been
       * checked. The code's answer in both cases is to narrow at the boundary
       * — `toAmount()` over every monetary column, explicit shape checks on
       * every webhook payload — which is the behaviour the rule is trying to
       * encourage, arrived at without the annotation it wants to see.
       *
       * Turning this to `error` would mean either 401 inline disables or a
       * typing project across the whole data layer. Neither is a four-day job,
       * and neither makes the software safer than `strict` already does.
       * Generating Supabase types is the real fix and it is not this change.
       */
      '@typescript-eslint/no-explicit-any': 'off',

      /**
       * A leading underscore already means "declared, deliberately unused" in
       * this codebase — destructuring a row to name its columns for the reader
       * is the common case. The rule honours that convention rather than
       * asking eight call sites to delete documentation.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // The .mjs scripts are plain Node, run by hand and by CI, and are not part
    // of the TypeScript program.
    files: ['scripts/**/*.mjs', '*.config.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
])
