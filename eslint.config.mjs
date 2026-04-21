import js from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import nodePlugin from 'eslint-plugin-n'

const noopRule = {
  meta: { type: 'problem', schema: [] },
  create() {
    return {}
  },
}

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'archive/**',
      'autoresearch.experiments/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  // Type-aware pass: runs on repo sources only (src-ish dirs). Slower but
  // needed for no-floating-promises / no-unnecessary-type-assertion which
  // require the TypeScript type checker.
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Bun: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      n: nodePlugin,
      'custom-rules': {
        rules: {
          'no-top-level-side-effects': noopRule,
          'no-process-env-top-level': noopRule,
          'safe-env-boolean-check': noopRule,
          'no-process-exit': noopRule,
          'no-sync-fs': noopRule,
          'prefer-use-keybindings': noopRule,
          'no-cross-platform-process-issues': noopRule,
          'no-lookbehind-regex': noopRule,
        },
      },
      'eslint-plugin-n': {
        rules: {
          'no-sync': noopRule,
        },
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'react/react-in-jsx-scope': 'off',
      'react-hooks/rules-of-hooks': 'off',
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
      'n/no-unsupported-features/node-builtins': 'off',
      // React Compiler emits code that trips these core rules (memoization
      // sentinels as constant conditions, empty else branches, etc.). The
      // emitted code is machine-generated and correct by construction.
      'no-empty': 'off',
      'no-constant-condition': 'off',
      'no-constant-binary-expression': 'off',
      'no-prototype-builtins': 'off',
      'no-useless-escape': 'off',
      'no-cond-assign': 'off',
      'no-case-declarations': 'off',
      'no-control-regex': 'off',
      'no-fallthrough': 'off',
      'no-sparse-arrays': 'off',
      'no-irregular-whitespace': 'off',
      'no-misleading-character-class': 'off',
      'no-async-promise-executor': 'off',
      'no-unsafe-finally': 'off',
      'no-unreachable': 'off',

      // Hot rules requested for the pre-launch hardening pass.
      // Start as 'warn' so a single rollout doesn't nuke CI — flip to
      // 'error' once counts are driven to zero.
      '@typescript-eslint/no-floating-promises': [
        'warn',
        { ignoreVoid: false, ignoreIIFE: false },
      ],
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // Non-TS config/scripts: lint JS/MJS without the type-aware parser
  // (type-aware project parsing requires TS files).
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Bun: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      n: nodePlugin,
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'n/no-missing-import': 'off',
    },
  },
  // Tests are allowed to floating-promise on mocks / fire-and-forget setup.
  {
    files: ['test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
]
