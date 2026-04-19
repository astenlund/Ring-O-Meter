import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

const sharedRules = {
    'semi': ['error', 'always'],
    'quotes': ['error', 'single', {avoidEscape: true, allowTemplateLiterals: true}],
    'no-trailing-spaces': 'error',
    'eol-last': ['error', 'always'],
    'indent': ['error', 4, {SwitchCase: 1}],
    'no-multiple-empty-lines': ['error', {max: 1, maxEOF: 0}],
    'no-var': 'error',
    'prefer-const': 'error',

    'eqeqeq': ['error', 'always', {null: 'ignore'}],
    'no-duplicate-case': 'error',
    'no-dupe-keys': 'error',
    'no-unreachable': 'error',
};

export default [
    {
        ignores: ['dist/**', 'node_modules/**', '.vite/**'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.{ts,tsx}'],
        plugins: {
            import: importPlugin,
            react,
            'react-hooks': reactHooks,
        },
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            parserOptions: {
                ecmaFeatures: {jsx: true},
            },
            globals: {
                window: 'readonly',
                document: 'readonly',
                console: 'readonly',
                navigator: 'readonly',
                AudioContext: 'readonly',
                AudioWorkletNode: 'readonly',
                AudioWorkletProcessor: 'readonly',
                MediaStream: 'readonly',
                MediaStreamConstraints: 'readonly',
                MediaDeviceInfo: 'readonly',
                requestAnimationFrame: 'readonly',
                cancelAnimationFrame: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                performance: 'readonly',
                self: 'readonly',
                registerProcessor: 'readonly',
            },
        },
        settings: {react: {version: 'detect'}},
        rules: {
            ...sharedRules,
            'react/jsx-uses-react': 'off',
            'react/react-in-jsx-scope': 'off',
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
            '@typescript-eslint/no-unused-vars': ['warn', {argsIgnorePattern: '^_'}],
        },
    },
];
