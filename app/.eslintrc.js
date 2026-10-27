// eslint-disable-next-line no-undef
module.exports = {
    root: true,
    env: {
        browser: true,
        es2021: true,
    },
    parserOptions: {
        // Numeric separators (10_000) and the like; ESLint 7 defaults to ES2018
        // and refuses to parse whole files otherwise.
        ecmaVersion: 2021,
        sourceType: 'module',
    },
    extends: [
        'eslint:recommended',
        'plugin:vue/recommended'
    ],
    globals: {
        // Replaced at build time by webpack's DefinePlugin (NODE_ENV, VUE_APP_*).
        process: 'readonly',
    },
    rules: {
        // `const { dropped, ...rest } = obj` is how this code omits a key.
        'no-unused-vars': ['error', { ignoreRestSiblings: true }],
        // `while (true) { ... break; }` paging loops are deliberate.
        'no-constant-condition': ['error', { checkLoops: false }],
        'vue/html-indent': ['error', 4],
        'vue/script-indent': ['error', 4],
        'quotes': ['error', 'single'],
        'semi': ['error', 'always']
    },
    ignorePatterns: ['src/js/comlink.js', 'src/wasm/*']
};
