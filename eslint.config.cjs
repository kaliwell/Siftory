const js = require('@eslint/js')
const tsParser = require('@typescript-eslint/parser')
const tsPlugin = require('@typescript-eslint/eslint-plugin')
const prettier = require('eslint-config-prettier')
const reactHooks = require('eslint-plugin-react-hooks')
const globals = require('globals')

module.exports = [
  {
    ignores: [
      'ai-models/',
      'artifacts/',
      'backup/',
      'cppbackup/',
      'dist/',
      'dist-electron/',
      'native/build*/',
      'node_modules/',
      'release/',
    ],
  },
  {
    files: ['**/*.{js,cjs}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      globals: { ...globals.browser, ...globals.node },
      sourceType: 'commonjs',
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-console': ['warn', { allow: ['error'] }],
      'no-useless-assignment': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'preserve-caught-error': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'electron/**/*.ts', 'shared/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: { ...globals.browser, ...globals.node },
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tsPlugin, 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,
      ...prettier.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-case-declarations': 'off',
      'no-console': ['warn', { allow: ['error'] }],
      'no-undef': 'off',
      'no-useless-assignment': 'error',
      'no-unused-vars': 'off',
      'preserve-caught-error': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    files: ['tests/**/*.{js,cjs}', 'scripts/**/*.{ts,js,cjs}', 'electron/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
]
