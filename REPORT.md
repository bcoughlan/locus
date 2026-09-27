# Report: locus-cli

## The result

`locus diff` works. It compares two versions of OpenAPI documents, prints each changed endpoint in full, marks each change, and exits with code 1 on a breaking change.

- Git mode: `locus diff "specs/*.yml"` compares the working tree with `origin/main`. `--base <ref>` picks another ref.
- Folder mode: `locus diff --source "../old/specs/*.yml" "specs/*.yml"`. Single files and folders work too.
- OpenAPI 3.0, 3.1, and 3.2. A 3.0 shim converts 3.0 schemas, so 3.0 and 3.1 give the same result for the same meaning.
- Colors: green added, orange compatible change, red breaking. `--no-color` keeps all information: markers `+ - ~` and `[breaking: reason]` tags.
- Exit codes: 0 no breaking change, 1 breaking change, 2 usage or input error.

## Try it

```sh
npm install
npm run check                                    # typecheck, lint, 463 tests, build
cd test-e2e/corpus/parameters/query-param-became-required
node ../../../../src/bin.ts diff --source base head
```

Every scenario folder under `test-e2e/corpus/` has an `output.txt` with the expected output. Skim a few of them: that is the fastest way to judge the tool.

## How it works

The diff is a pipeline. Each stage returns plain data.

- Sources: patterns to files. Git mode copies the base files, plus every file that their `$ref`s reach, into a tmp-promise folder. Then both modes run the same folder code.
- Loading: YAML and JSON, `$ref`s across files, relative to the file that holds them.
- Model: each endpoint becomes a view tree: parameters, bodies, responses, headers, schemas, security, callbacks, webhooks. `allOf` merges. Cycles stop with a marker.
- Diff: endpoints match by `operationId`, then by method and path. Nodes match by kind and key. A rules table classifies each change by direction (client sends or client receives).
- Render: the diff report is a generic tree of plain objects. The console renderer prints it. An HTML renderer can use the same report.

The diff runs on the same tree that the renderer prints. So every change the diff finds is visible, and every visible fact is compared.

## Evidence of quality

- 463 tests, all green: 254 unit tests, 183 corpus snapshots, 26 CLI and git snapshot tests.
- The rules table has one test per rule in `docs/breaking-changes.md` (about 140 rows).
- Each milestone had a code review and a simplify pass. Reviews found real bugs, for example an empty `--source` that passed CI without a comparison. All findings are fixed or listed below.
- Two subagents read all 183 outputs as a user does. Every exit code matched. Their display findings are fixed.
- The Stripe spec (8 MB, 612 endpoints) runs in about 15 seconds. A removed property in `customer` flags all 147 endpoints that return it.
- `npm pack`, install into an empty project, and `npx locus diff` work.

## Decisions you can overrule

- TypeScript 6, not 7. typescript-eslint does not support TypeScript 7 yet.
- Git mode compares with the working tree, not the HEAD commit, so uncommitted edits show. In CI the two are the same.
- Unchanged endpoints are hidden. `--all` shows them.
- A removed request property or parameter is breaking: clients that send it lose its effect.
- A changed `pattern` is always breaking, because the tool cannot compare regular expressions.
- A new 2XX response is compatible.
- The `openapi` version is not compared. A 3.0 to 3.1 upgrade alone shows no change.
- The hello-world program is gone. It proved the scaffold, then the real CLI replaced it.
- The GitHub Actions workflows exist but never ran, because the repository has no remote yet.

## Known limits

- Very large specs: over 200,000 tree nodes, the tool expands fewer nested `$ref` levels and warns. A deep change then shows only where the schema appears at a shallow level. A better fix: share one subtree per schema instead of copying it.
- Not followed: remote `$ref`s (`https://`) and `$anchor` references. The tool warns.
- Not compared: `x-*` extensions, XML objects, links, and encoding objects.
- A schema with two `oneOf`/`anyOf` lists compares only the first one. The tool warns.
- A changed security requirement shows as removed plus added, not as one paired change.

## Where to look

- `docs/breaking-changes.md`: the rules.
- `docs/devlog.md`: what each review found, and what I changed after each milestone.
- `docs/PLAN.md`: the design and the milestones.
- `src/diff/rules.ts`: the rules table in code.
