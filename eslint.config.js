import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'frontend/**', 'node_modules/**', 'backend/src/generated/**', 'storage/**', 'coverage/**'] },
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
  { files: ['tests/**'], rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-non-null-assertion': 'off' } },
);
