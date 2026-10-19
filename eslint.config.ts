import eslint from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import eslintPluginPrettier from 'eslint-plugin-prettier/recommended'

export default defineConfig(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  eslintPluginPrettier,
  {
    languageOptions: {
      // List both projects so files in src/, test/, AND webapp/ resolve
      // to the right tsconfig (different lib/jsx/module settings between
      // the Node plugin and the browser webapp).
      parserOptions: {
        project: ['./tsconfig.eslint.json', './tsconfig.webapp.json'],
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^$',
          varsIgnorePattern: '^$'
        }
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true }
      ]
    }
  },
  {
    ignores: ['plugin/**', 'public/**', 'node_modules/**']
  }
)
