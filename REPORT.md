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
npm run check                                    # typecheck, lint, 472 tests, build
cd test-e2e/corpus/parameters/query-param-became-required
node ../../../../src/bin.ts diff --source base head
```

Every scenario folder under `test-e2e/corpus/` has an `output.txt` with the expected output. Skim a few of them. That is the fastest way to judge the tool.

## How it works

The diff is a pipeline. Each stage returns plain data.

- Sources: patterns to files. Git mode copies the base files, plus every file that their `$ref`s reach, into a temporary folder. Then both modes run the same folder code.
- Loading: YAML and JSON. A `$ref` resolves on demand, relative to the file that holds it.
- Model: each endpoint becomes a view tree: parameters, bodies, responses, headers, schemas, security, callbacks, webhooks. `allOf` merges.
- References stay references. Each schema is built once per direction, in a table. A cycle points back to its definition.
- Diff: endpoints match by `operationId`, then by method and path. Nodes match by kind and key. Each pair of schema definitions is compared once. A rules table classifies each change by direction (client sends or client receives).
- Render: the diff report is a generic tree of plain objects. The console renderer expands references while it prints. An HTML renderer can use the same report.

The diff runs on the same tree that the renderer prints. So every change the diff finds is visible, and every visible fact is compared.

Every node carries its file and JSON pointer. `DocumentStore.lineOf()` turns them into a line number, for a future UI that jumps to the spec.

`docs/developer-guide.html` explains the architecture for human developers, with diagrams. It is one file. Open it in a browser.

## Evidence of quality

- 472 tests, all green: 261 unit tests, 184 corpus snapshots, 27 CLI and git snapshot tests.
- The rules table has one test per rule in `docs/breaking-changes.md` (about 140 rows).
- Each milestone had a code review and a simplify pass. Reviews found real bugs, for example an empty `--source` that passed CI without a comparison. All findings are fixed or listed below.
- Two subagents read all corpus outputs as a user does. Every exit code matched. Their display findings are fixed.
- Stripe spec (8 MB, 612 endpoints): a self-diff takes about 2 seconds.
- Stripe with one removed `customer` property: 2.6 seconds, all 612 endpoints breaking. That is correct: every error response embeds a customer through `payment_intent`.
- `npm pack`, install into an empty project, and `npx locus diff` work.

## Decisions you can overrule

- TypeScript 6, not 7. typescript-eslint does not support TypeScript 7 yet.
- Git mode compares with the working tree, not the HEAD commit, so uncommitted edits show. In CI the two are the same.
- Unchanged endpoints are hidden. `--all` shows them.
- Large endpoints: after 400 printed lines, an endpoint shows only the shortest paths to its changes. Unchanged parts show as a count (`… 12 unchanged, not shown`). Without this rule, the Stripe output was 4 million lines. With it, 320,000.
- A removed request property or parameter is breaking: clients that send it lose its effect.
- A changed `pattern` is always breaking, because the tool cannot compare regular expressions.
- A new 2XX response is compatible.
- The `openapi` version is not compared. A 3.0 to 3.1 upgrade alone shows no change.
- The hello-world program is gone. It proved the scaffold, then the real CLI replaced it.

## Known limits

- Not followed: remote `$ref`s (`https://`) and `$anchor` references. The tool warns.
- Not compared: `x-*` extensions, XML objects, links, and encoding objects.
- Inside `not`, every change counts as breaking. A shared schema that `not` refers to keeps its normal tags in the output, but the endpoint result is still breaking.
- A schema with two `oneOf`/`anyOf` lists compares only the first one. The tool warns.
- A changed security requirement shows as removed plus added, not as one paired change.
- The GitHub Actions workflows never ran, because the repository has no remote yet.

## State of the branches

- The reference model and the final review fixes are on branch `refs-on-the-fly`. I did not merge it into `main`, so you can review it first.
- Another session created two worktrees under `.claude/worktrees/` (`arch-primitives`, `head-baseline`). I did not touch them.

## Where to look

- `docs/developer-guide.html`: the architecture, with diagrams.
- `docs/breaking-changes.md`: the rules.
- `docs/devlog.md`: what each review found, and what I changed after each milestone.
- `docs/PLAN.md`: the design and the milestones.
- `src/diff/rules.ts`: the rules table in code.
