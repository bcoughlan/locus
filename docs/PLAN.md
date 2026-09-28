# Plan

## Goal

locus-cli is a command-line tool that compares two versions of a set of OpenAPI documents. It prints each changed endpoint in full and marks every change. Green marks an addition. Orange marks a compatible change. Red marks a breaking change. The tool exits with code 1 when it finds a breaking change.

Two modes select the base version:

```sh
locus diff --base origin/main "specs/*.yml"         # git mode (default base: origin/main)
locus diff --source "../old/specs/*.yml" "specs/*.yml"   # folder mode
```

## Architecture

The diff runs as a pipeline of five stages. Each stage has one job and returns plain data.

1. Sources. The tool turns the command-line arguments into two lists of files: base and head. In git mode, the tool copies the base files from a git ref into a temporary folder. After this stage, git mode and folder mode run the same code.
2. Loading. The tool parses each file (YAML or JSON), resolves `$ref` values across files, and detects the OpenAPI version.
3. Model. The tool converts each document into a view tree. A view tree is a version-independent tree of display nodes. A shim converts OpenAPI 3.0 schemas to 3.1 form. For example, `nullable: true` becomes a `"null"` type. OpenAPI 3.1 and 3.2 use the same code path.
4. Diff. The tool matches endpoints by `operationId`, then by method and path. It compares the two view trees node by node. A rules table classifies each change as breaking or compatible. The result is a diff report, the generic output structure for all renderers.
5. Render. A docs model turns each endpoint of the diff report into docs with the changes marked: a change digest, parameter tables, and body and response blocks. Schemas show as lines of styled text. The console renderer prints the docs model, with or without color. The HTML renderer (`--html`) prints it as one page of API docs, with a sidebar, count pills, and a toggle for unchanged endpoints.

The diff runs on the same tree that the renderer prints. Thus each change that the diff finds is visible in the output, and each visible fact takes part in the diff.

## Tools and libraries

| Need | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript 6, run natively by Node.js 24.8 or later | Node.js strips types at run time. `tsc` emits `dist/*.js` for the published package. TypeScript 7 is not compatible with typescript-eslint yet. |
| Command line | commander | Requested. |
| YAML and JSON | yaml | Popular, keeps JSON compatibility. |
| Colors | chalk | Popular, supports orange through `hex`, degrades on basic terminals. |
| Temporary folders | tmp-promise | Requested. |
| Globs | `fs.glob` and `path.matchesGlob` from Node.js | Built in. The same glob engine matches files on disk and file names from `git ls-tree`. |
| `$ref` resolution | Own code, based on apion `SpecSource` | Libraries inline references and lose schema names and cycle markers. The display needs both. |
| Tests | vitest | Requested. |
| Lint | ESLint with typescript-eslint | Same as openapi-commander. |

## Milestones

Each milestone ends with the same quality gate:

1. Run `/code-review` on the milestone diff and fix the findings.
2. Run `/simplify` and apply the useful changes.
3. Write a reflection in `docs/devlog.md`. The reflection answers one question: "If I started this milestone again, what would I do differently?"
4. Act on the reflection: tweak, or re-implement part of the milestone.
5. Run the full check (`npm run check`) and commit.

| Milestone | Content | Done when |
| --- | --- | --- |
| M0 Scaffold | package.json, tsconfig, vitest, ESLint, bin script, hello-world program with a unit test and an e2e test, GitHub Actions, CLAUDE.md | Build, lint, and tests pass. `node bin/run.js` runs the built code. |
| M1 Rules | `docs/breaking-changes.md`: the list of breaking and compatible changes | Each rule has a class for each direction (request and response). A rule that is not obvious has a reason. |
| M2 Loading | Glob and folder expansion, file pairing, parsing, multi-file `$ref` resolution, version detection, 3.0 shim | Unit tests cover refs across files, cycles, and the shim. |
| M3 Model | Document to view tree: endpoints, parameters, bodies, responses, headers, schemas, security, callbacks, webhooks | Unit tests cover each node kind. |
| M4 Diff | Endpoint matching, tree diff, rules table, severity roll-up | One unit test per rule. |
| M5 CLI | `locus diff` in folder mode, console renderer, `--no-color`, `--all`, exit codes | E2E smoke tests call `main()` directly. |
| M6 Git | `--base <ref>`: copy base files and their `$ref` targets into a temporary folder | One e2e test runs against a temporary git repository. |
| M7 Corpus | Many fixture pairs across the OpenAPI 3.2 specification, snapshot tests, review rounds | Reviewers accept the snapshot output. |
| M8 Finish | README, CLAUDE.md, REPORT.md, final review | All checks pass. |

## Use of subagents

Subagents do work that is large, parallel, and independent of the main context.

| Task | Subagents | Reason |
| --- | --- | --- |
| Fixture corpus (M7) | 4, one per area: parameters, bodies and schemas, responses and headers, security and servers and webhooks and callbacks and version features | Many YAML files. Each area is independent. |
| Snapshot review (M7) | 2 to 3, each reads a share of the snapshot files | Fresh eyes judge the output as a user does. |
| Code review (each milestone) | Run by the `/code-review` skill | Independent review of the diff. |

The main agent writes all production code. This keeps one consistent design.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | No breaking changes. |
| 1 | At least one breaking change. |
| 2 | Usage error or input error, for example a file that does not parse. |
