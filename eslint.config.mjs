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
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
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
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      n: nodePlugin,
      'custom-rules': {
        rules: {
          'no-top-level-side-effects': noopRule,
          'no-process-env-top-level': noopRule,
          'safe-env-boolean-check': noopRule,
          'no-process-exit': noopRule,
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
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'off',
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
    },
  },
]
