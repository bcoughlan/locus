# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

locus-cli (command `locus`) is a Node.js command-line tool that compares two versions of OpenAPI documents (3.0, 3.1, 3.2). It prints each changed endpoint in full, marks each change, and exits with code 1 when a change breaks clients. `docs/PLAN.md` describes the design. `docs/breaking-changes.md` holds the rules.

## Commands

```sh
npm run check        # typecheck, lint, all tests, build. Run this before each commit.
npm test             # all tests (vitest run)
npm run test:unit    # unit tests in src/
npm run test:e2e     # end-to-end tests in test-e2e/
npx vitest run src/diff/rules.test.ts      # one test file
npx vitest run -t "required query"         # tests whose name matches
npx vitest run test-e2e/corpus.test.ts -u  # rewrite the corpus snapshots, then review each output.txt diff
npm run build        # tsc -p tsconfig.build.json, emits dist/
node src/bin.ts diff --source old new      # run the CLI from source (Node.js strips the types)
node bin/run.js diff --source old new      # run the built CLI (run npm run build first)
```

## TypeScript setup

- The source is TypeScript that Node.js runs natively. Imports use the `.ts` extension. `tsc` rewrites them to `.js` in `dist/` (`rewriteRelativeImportExtensions`).
- `erasableSyntaxOnly` is on. Do not use enums, namespaces, or constructor parameter properties.
- `tsconfig.json` type-checks everything and emits nothing. `tsconfig.build.json` emits `src/` without tests and without `src/testing/`.
- TypeScript stays on version 6 because typescript-eslint does not support TypeScript 7.

## Architecture

The diff is a pipeline. Each stage returns plain data.

1. `src/sources/`: command-line patterns to files (`files.ts`), and git mode (`git.ts`), which copies the base files from a git ref into a temporary folder. After that, git mode and `--source` mode run the same code.
2. `src/load/`: YAML/JSON parsing and `$ref` resolution across files (`documents.ts`). A reference resolves against the file it appears in.
3. `src/model/`: each document becomes view trees (`tree.ts`), one per operation. `schema.ts` merges `allOf`, stops cycles with a `recursive` marker, and applies the 3.0 shim (`src/oas/shim30.ts`). 3.0 knowledge stays in the shim. 3.1 and 3.2 share one code path.
4. `src/diff/`: `diff.ts` matches operations (operationId, then method and path) and nodes (kind and key), and compares attributes. `rules.ts` classifies each change. `report.ts` defines the diff report, the output structure for all renderers.
5. `src/render/`: `console.ts` prints the report. `format.ts` holds text helpers that an HTML renderer can share.

Key rules of the design:

- The diff runs on the same tree that the renderer prints. A new fact in the model needs a display in the renderer and a rule in `rules.ts`, and the rule needs a row in `docs/breaking-changes.md`.
- Each node has a direction: `request` (the client writes the value) or `response` (the client reads it). Webhooks and callbacks flip it. Most schema rules depend on it.
- Input documents are untrusted. Read fields through the guards in `src/util.ts`.
- `main(argv, io)` in `src/main.ts` returns the exit code and never calls `process.exit`: 0 no breaking change, 1 breaking change, 2 usage or input error (`InputError`). The e2e tests call `main()` in-process with a capturing `io`.

## Tests

- Unit tests sit next to the code (`src/**/*.test.ts`). `src/testing/build-yaml.ts` builds a model from inline YAML.
- End-to-end tests favor snapshots of the whole run. `transcript()` in `test-e2e/helpers.ts` turns a run into text (exit code, stdout, stderr) and replaces temporary paths with `<tmp>`. Use targeted assertions only for facts that a snapshot cannot show, such as color codes.
- `test-e2e/corpus/` holds diff scenarios: `base/`, `head/`, `scenario.yml` (the expected class), and `output.txt` (the snapshot). See `test-e2e/corpus/README.md`. After an intended output change, update with `-u` and read the diff of each `output.txt`.
- `test-e2e/git.test.ts` builds a temporary git repository with an empty global git configuration.
