# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

locus-cli (command `locus`) is a Node.js command-line tool that validates and compares OpenAPI documents. `docs/PLAN.md` describes the design and the milestones.

## Commands

```sh
npm run check        # typecheck, lint, all tests, build. Run this before each commit.
npm test             # all tests (vitest run)
npm run test:unit    # unit tests in src/
npm run test:e2e     # end-to-end tests in test-e2e/
npx vitest run src/hello-world.test.ts   # one test file
npx vitest run -t "writes the greeting"  # tests whose name matches
npm run build        # tsc -p tsconfig.build.json, emits dist/
node src/index.ts    # run the TypeScript source directly (Node.js strips the types)
node bin/run.js      # run the built CLI (run npm run build first)
```

## TypeScript setup

- The source is TypeScript that Node.js runs natively. Imports use the `.ts` extension. `tsc` rewrites them to `.js` in `dist/` (`rewriteRelativeImportExtensions`).
- `erasableSyntaxOnly` is on. Do not use enums, namespaces, or constructor parameter properties.
- `tsconfig.json` type-checks everything and emits nothing. `tsconfig.build.json` emits `src/` without the tests.
- TypeScript stays on version 6 because typescript-eslint does not support TypeScript 7.

## Architecture

- `bin/run.js` imports `dist/main.js`. The published package contains only `bin/` and `dist/`.
- `src/main.ts` exports `main(argv, io)`. It builds a new commander program on each call and returns the exit code. It never calls `process.exit`. The e2e tests call `main()` in-process with a capturing `io`. They do not start a subprocess.
- Unit tests sit next to the code (`src/**/*.test.ts`). E2E tests live in `test-e2e/`.
