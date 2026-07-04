/**
 * ESLint config for the news bot, ported from the blog frontend
 * (blog-app-mui-frontend/.eslintrc.cjs) to keep ONE house style across the
 * monorepo. The React/JSX/a11y layers are dropped — this is a Node TS service,
 * not a React app — so it extends airbnb-base (not airbnb). The transferable
 * rules are kept verbatim: perfectionist import/export sorting, unused-imports,
 * ban-ts-comment, import/no-cycle, and the max-lines:200 size budget, all at the
 * same `error` ratchet so new violations fail lint/CI instead of warning.
 */
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  plugins: ["perfectionist", "unused-imports", "prettier", "@typescript-eslint"],
  extends: ["airbnb-base", "prettier"],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  settings: {
    "import/resolver": {
      node: { extensions: [".js", ".ts", ".json"] },
    },
  },
  /**
   * 0 ~ 'off'
   * 1 ~ 'warn'
   * 2 ~ 'error'
   */
  rules: {
    "no-use-before-define": 0,
    "no-alert": 0,
    "no-undef": 0,
    "no-redeclare": 0,
    camelcase: 0,
    // The bot logs operational events to the console by design (systemd journal).
    "no-console": 0,
    "no-unused-vars": 0,
    "no-nested-ternary": 0,
    "no-param-reassign": 0,
    "no-underscore-dangle": 0,
    "no-restricted-exports": 0,
    "no-promise-executor-return": 0,
    "no-continue": 0,
    "no-plusplus": 0,
    "no-await-in-loop": 0,
    "class-methods-use-this": 0,
    // `void` for fire-and-forget promises and `^=`/`<<` in the dedup hash are
    // idiomatic here — airbnb bans them for app code, but this is a Node service.
    "no-void": 0,
    "no-bitwise": 0,
    // airbnb's no-restricted-syntax bans `for...of` (it predates native async
    // iteration); the bot uses `for...of` / `for await` heavily and idiomatically.
    // Keep the other useful bans (for-in, labeled statements, `with`).
    "no-restricted-syntax": [
      2,
      {
        selector: "ForInStatement",
        message:
          "for..in iterates the prototype chain — use Object.keys/values/entries instead.",
      },
      {
        selector: "LabeledStatement",
        message: "Labels are a form of GOTO; refactor the control flow instead.",
      },
      { selector: "WithStatement", message: "`with` is disallowed in strict mode." },
    ],
    "import/prefer-default-export": 0,
    "import/extensions": 0,
    "import/no-unresolved": 0,
    "import/named": 0,
    "import/no-self-import": 0,
    // Circular deps start at zero — lock that in as an error so they can never
    // be reintroduced (same ratchet as the frontend).
    "import/no-cycle": [2, { maxDepth: 1, ignoreExternal: true }],
    // @ts-nocheck/@ts-ignore banned outright; @ts-expect-error allowed only with
    // a written justification (and self-clears once the upstream type is fixed).
    "@typescript-eslint/ban-ts-comment": [
      2,
      {
        "ts-nocheck": true,
        "ts-ignore": true,
        "ts-expect-error": "allow-with-description",
        minimumDescriptionLength: 10,
      },
    ],
    "import/no-relative-packages": 0,
    "import/no-extraneous-dependencies": 0,
    "import/order": 0,
    "import/first": 0,
    "prefer-destructuring": [1, { object: true, array: false }],
    // Dead imports are noise and a refactor hazard — never allow them. Autofixable.
    "unused-imports/no-unused-imports": 2,
    // Unused vars are an error repo-wide; `_`-prefixed names are intentional.
    "unused-imports/no-unused-vars": [
      2,
      {
        vars: "all",
        varsIgnorePattern: "^_",
        args: "after-used",
        argsIgnorePattern: "^_",
      },
    ],
    // perfectionist — sort imports/exports by line length, ascending.
    "perfectionist/sort-exports": [1, { order: "asc", type: "line-length" }],
    "perfectionist/sort-named-imports": [1, { order: "asc", type: "line-length" }],
    "perfectionist/sort-named-exports": [1, { order: "asc", type: "line-length" }],
    "perfectionist/sort-imports": [
      1,
      {
        order: "asc",
        type: "line-length",
        newlinesBetween: "always",
        groups: [
          "style",
          "type",
          ["builtin", "external"],
          "internal",
          ["parent", "sibling", "index"],
          ["parent-type", "sibling-type", "index-type"],
          "object",
          "unknown",
        ],
      },
    ],
    // One module per file, kept small (~150-200 lines, blanks/comments excluded).
    // Locked at error like the frontend — any new oversized file fails lint/CI.
    "max-lines": [2, { max: 200, skipBlankLines: true, skipComments: true }],
  },
  overrides: [
    {
      // Tests legitimately run long (many cases per file) and assert on private
      // state — exempt them from the per-module size budget and allow the
      // justified @ts-expect-error used to reach into a private field in a test.
      files: ["tests/**"],
      rules: {
        "max-lines": 0,
      },
    },
    {
      // The eval harness is dev-only tooling (fixtures with many cases, a CLI
      // runner), not shipped service code — exempt it from the module size
      // budget for the same reason as tests.
      files: ["evals/**"],
      rules: {
        "max-lines": 0,
      },
    },
  ],
};
