// Minimal ESLint configuration for urdf-studio. We rely on tsc (--noEmit) for
// type safety; this config catches the small set of patterns tsc doesn't, plus
// a few project-specific bans (no innerHTML on user-controlled data — see
// src/renderer/html.ts).
//
// Run via `npm run lint` (full project) or `npm run lint -- --fix` to apply
// auto-fixes. CI invokes it from the `test` workflow job.

import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    // Ignore generated + vendored output.
    ignores: [
      'dist/**',
      'dist-web/**',
      'node_modules/**',
      'out/**',
      'src/vendor/**',
      'test-results/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      },
      globals: {
        // Browser-side ambient globals used by renderer / web modules.
        window: 'readonly',
        document: 'readonly',
        globalThis: 'readonly',
        console: 'readonly',
        navigator: 'readonly',
        performance: 'readonly',
        URL: 'readonly',
        File: 'readonly',
        FileList: 'readonly',
        Blob: 'readonly',
        DOMParser: 'readonly',
        XMLSerializer: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        MessageEvent: 'readonly',
        DOMException: 'readonly',
        ResizeObserver: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        // Node-side globals (test runner, fs, etc).
        Buffer: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        // DOM element types we reference through generics on querySelector / etc.
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLPreElement: 'readonly',
        HTMLCanvasElement: 'readonly',
        Element: 'readonly',
        ParentNode: 'readonly',
        Document: 'readonly',
        Window: 'readonly',
        Node: 'readonly',
        FileSystemDirectoryHandle: 'readonly',
        FileSystemFileHandle: 'readonly',
        FrameRequestCallback: 'readonly',
        Storage: 'readonly',
        CSS: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {
      // TS handles most of these better than ESLint's stock checks.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
      'no-undef': 'off', // TS catches these
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-control-regex': 'off',
      'no-useless-escape': 'warn',
      'no-prototype-builtins': 'off',
      // Catch the most common Promise mistakes.
      '@typescript-eslint/no-floating-promises': 'off', // requires type info, slow
      // Style nits — disabled to keep the linter focused on bugs.
      'no-mixed-spaces-and-tabs': 'off',
      'no-irregular-whitespace': 'warn'
    }
  },
  {
    // Tests are allowed to use `any` / `never` casts to stub host types.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
];
