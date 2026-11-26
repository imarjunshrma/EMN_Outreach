import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import next from '@next/eslint-plugin-next';

export default tseslint.config(
  { ignores: ['dist/**', 'frontend/.next/**', 'frontend/.next-e2e/**', 'frontend/next-env.d.ts', 'node_modules/**', 'backend/src/generated/**', 'storage/**', 'coverage/**', '.ai-subscriptions/**', '.local-dev/**', 'test-results/**', 'playwright-report/**', '.next/**', '.next-e2e/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/frontend/**'], message: 'Server code must not import the frontend.' }] }],
    },
  },
  {
    files: ['frontend/**/*.{js,mjs,ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, '@next/next': next },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@next/next/no-img-element': 'warn',
    },
  },
  { files: ['tests/**'], rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-non-null-assertion': 'off' } },
);
