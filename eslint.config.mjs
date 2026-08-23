// ESLint flat config — core rules only (no plugins, no type info).
// Targets split by runtime: host files run under Node, client/service-worker
// files run in the browser/worker. `npm run lint` reproduces the CI check.
const core = {
  // correctness
  'no-undef': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': 'error',
  'no-cond-assign': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-func-assign': 'error',
  'no-obj-calls': 'error',
  'no-sparse-arrays': 'error',
  'no-unexpected-multiline': 'error',
  'no-with': 'error',
  'no-prototype-builtins': 'error',
  'no-async-promise-executor': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'valid-typeof': 'error',
  'no-case-declarations': 'error',
  'no-fallthrough': 'error',
  'no-new-wrappers': 'error',
  'no-redeclare': 'error',
  'no-self-assign': 'error',
  'no-useless-catch': 'error',
  'no-useless-escape': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-extra-boolean-cast': 'error',
  // hygiene (warnings)
  'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-unneeded-ternary': 'warn',
  'prefer-const': 'warn',
  'prefer-regex-literals': 'warn',
  'no-irregular-whitespace': 'warn'
}

const lang = { ecmaVersion: 'latest', sourceType: 'module' }

export default [
  {
    files: ['lib/index.js', 'lib/daemon.mjs', 'cf-auth-proxy.mjs'],
    languageOptions: {
      ...lang,
      globals: {
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', URL: 'readonly', fetch: 'readonly',
        WebSocket: 'readonly', Blob: 'readonly', AbortSignal: 'readonly',
        btoa: 'readonly'
      }
    },
    rules: core
  },
  {
    files: ['lib/client.js', 'iptunnel-sw.js', 'iptunnel-watchdog.js'],
    languageOptions: {
      ...lang,
      globals: {
        window: 'readonly', document: 'readonly', localStorage: 'readonly',
        navigator: 'readonly', console: 'readonly', fetch: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', MutationObserver: 'readonly', URL: 'readonly',
        btoa: 'readonly', atob: 'readonly', crypto: 'readonly', location: 'readonly',
        self: 'readonly', caches: 'readonly', Headers: 'readonly',
        Request: 'readonly', Response: 'readonly', Blob: 'readonly',
        TextDecoder: 'readonly', TextEncoder: 'readonly', getComputedStyle: 'readonly',
        addEventListener: 'readonly', removeEventListener: 'readonly'
      }
    },
    rules: core
  }
]
