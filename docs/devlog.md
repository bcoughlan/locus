# Development log

This log records the reflection at the end of each milestone. Each entry answers one question: what do I change if I start the milestone again?

## M0 Scaffold

Result: the TypeScript project builds, lints, and passes its tests. `node bin/run.js` runs the built code, and `node src/index.ts` runs the source.

What the review found:

- Usage errors exited with code 1. Code 1 means "breaking changes found", so a typo in CI looked like a breaking change. Usage errors now exit with code 2.
- The Node.js versions disagreed: `engines` said 24, `@types/node` said 26. The type checker then accepts APIs that fail on Node.js 24. `@types/node` now follows the lowest supported version. `path.matchesGlob` is stable only from Node.js 24.8, so `engines` requires 24.8.
- The release workflow had no check that the git tag matches the package version.

Reflection:

- I chose TypeScript 6, not 7. typescript-eslint does not support TypeScript 7 yet, so `npm-check-updates -u` breaks the install. This is a deliberate exception to "use the latest libraries".
- Next time, I decide the exit-code contract before the first line of code. The contract is part of the CLI interface, and the first test locked in the wrong code.
- Decision: keep the design. No re-implementation.

## M1 Rules and M2 Loading

Result: `docs/breaking-changes.md` lists the rules. The loading layer expands files, folders, and globs, parses YAML and JSON, resolves `$ref`s across files, detects the version, and converts 3.0 schemas.

What the review found:

- `openapi: 3.0` without quotes parses as the number 3 and failed the version check.
- The 3.0 shim dropped `nullable` next to `allOf`. A common 3.0 pattern thus lost its "null allowed" fact, and a change of it was invisible.
- A literal path such as `api[v2].yml` went to the glob engine, which matched nothing and exited 0.
- A folder named `..draft` counted as outside its parent.
- The rules document had no rows for `const`, nested schemas, or the 3.2 `querystring` location.

What the simplify pass found:

- The loader and the resolver each parsed `$ref` strings. One `parseRef` helper now serves both.
- The sources stage threw an error type of the loading stage. One `InputError` type now marks all input problems. The CLI maps it to exit code 2.
- `locus diff --source a.yml b.yml` pairs two differently named files. The first version also paired two glob matches when each glob matched one file. Now only files named directly pair by position.

Reflection:

- Next time, I define the cross-cutting pieces first: the error type, the reference parser, and the exit codes. Each late fix touched several modules.
- The first shim leaked a 3.0 keyword (`nullable`) into the version-independent model. The shim now rewrites it to a `{type: "null"}` alternative, and the model already handles that form. Rule: 3.0 knowledge stays in `shim30.ts`.
- Decision: tweak, no re-implementation. The pipeline split held up.

## M3 Model

Result: each document becomes one view tree per operation. `allOf` merges into one schema, `$ref` cycles stop with a marker, and 3.0, 3.1, and 3.2 give the same tree for the same meaning.

What the review found:

- The recursion check was too wide. It used one set of "enclosing" references for a whole subtree, so a property that reused a schema of its parent's `allOf` showed as recursive and lost its fields. I replaced the set with provenance: each nested schema carries the references whose content holds it. The check is now exact and still ends on every cycle.
- `null` disappeared from schemas without a known type, for example a nullable `oneOf`. A new `nullable` fact covers that case.
- Some spec features dropped without a trace: boolean schemas, `unevaluatedProperties: false`, the 3.2 `defaultMapping`, the description next to a Reference Object, and `x-*` keys under `paths`.

Reflection:

- The recursion bug was a design error, not a slip. Next time, I write down the invariant ("a cycle is a reference to a schema whose content holds this one") before the code, and I test the reuse case, not only the cycle case.
- Decision: re-implemented the recursion part of `schema.ts`. The rest stayed.

## M4 Diff

Result: operations match by `operationId`, then by method and path. Nodes match by kind and key. A rules table classifies each change, and a subtree that is added or removed gets one verdict at its root.

What the review found:

- Several rules had the wrong direction or ignored context: `additionalProperties: false` turning into a schema, optional authentication (`{}`), changes inside `not` (which reverses every rule), a rename of a recursive schema, and operation servers that inherit from the document.
- Matching by key alone paired a property named `not` with a `not` schema.

Reflection:

- The generic tree diff held up well: most fixes were one rule or one matching detail. The rules need context (the parent on both sides), so next time I pass it from the start.
- Decision: tweak, no re-implementation.

## M5 CLI and M6 Git

Result: `locus diff` works in folder mode and in git mode. The output reads like API documentation with diff markers. Exit codes are 0, 1, and 2.

What the review found:

- An empty base (for example `--source 'old/*.yaml'` for `.yml` files) reported every head file as new and exited 0. CI then passed without a comparison. An empty side is now an input error in folder mode.
- The renderer always wrote truecolor codes, and it hid `explode: false` and `default: false`.
- A non-OpenAPI YAML file in a folder (a Helm template) stopped the whole diff.

What the corpus and the Stripe spec found:

- The Stripe spec (8 MB) ran out of memory: each endpoint expands its schemas in full, and Stripe's objects link to each other. Each document now has a node budget. Over the budget, it expands fewer nested `$ref` levels and says so. Both sides use the same depth. Stripe now takes about 15 seconds.
- A version upgrade (3.0 to 3.1) showed as a change. The `openapi` field is no longer a compared fact.
- A whole-object comparison of OAuth flows marked an added flow as breaking. Flows are now child nodes.
- Path matching ignored the text inside `{...}`, which also hid a changed callback expression.

Reflection:

- Next time, I test with a large real-world spec in the first model milestone. Full expansion is the core of the display, and its cost showed up late.
- A PowerShell bulk replace corrupted three files. I restored them from git. From then on, I edited only with the Edit tool.
- Decision: tweak, no re-implementation.

## M7 Corpus

Result: 183 end-to-end scenarios in eight areas, each with the expected class and a snapshot of the output. Four subagents wrote the fixtures. Two more subagents read all outputs as reviewers.

What the corpus found:

- The first run failed seven scenarios: version upgrades showed as changes, a header name that changed only in case showed as a rename, and an added OAuth flow counted as breaking.
- The reviewers confirmed every exit code, and they found display problems: a false `explode` change (the model compared stored values, not effective ones), additions printed before removals, enum changes that repeated the whole list, and reasons that did not name the item or the direction.
- The CLI and git tests used hand-written assertions. They now snapshot the whole run, as the user asked. The first snapshot run caught a wrong count in the summary.

Reflection:

- Snapshots of real scenarios found more display problems than the unit tests did. Next time, I start the corpus right after the first renderer, not after the git mode.
- Subagents wrote fixtures fast, and their disagreement reports gave early signal. A rate limit stopped three of them partway, and their partial work was still usable because each scenario was self-contained.
- Decision: tweak, no re-implementation.

## M8 References stay references

The user pointed out a design flaw: the model copied every referenced schema into each place of use. That costs memory, and it loses the location in the spec, so a UI cannot jump to a line.

Result:

- A `$ref` stays a reference in the model. Each schema is built once per direction, in a table. A cycle points back to its definition.
- The diff compares each pair of definitions once and shares the result.
- The console renderer expands references while it prints. It stops at cycles. In a large endpoint, it names unchanged referenced schemas.
- Every node has a source (file and JSON pointer). `DocumentStore.lineOf` gives the line number.
- The node budget and its depth fallback are gone.
- All 209 end-to-end snapshots stayed the same.
- Stripe: a self-diff takes 3.6 seconds (before: 15 seconds). A removed `customer` property now flags all 612 endpoints, because every error response embeds a customer through `payment_intent`. The old depth limit hid that path and flagged 147.

Reflection:

- The first model optimized for the simplest diff (plain trees) and paid for it in memory and lost locations. Next time, I keep the input's own structure (references) in the model from the start, and expand only where a person reads the output.
- Keeping all output snapshots before the refactor made it safe: the refactor had a precise target.
- Decision: re-implemented the model's schema part, the diff's reference handling, and the renderer's expansion.

Final review of M8 (ten findings, all fixed):

- A change inside a reference cycle did not reach every node of the cycle. The diff now settles the impacts after the comparison.
- A 3.0 `nullable` that moved from the use of a schema into the schema showed as a change at the use.
- 3.1 honored a `nullable` keyword next to a `$ref`. 3.1 has no such keyword.
- A description next to a `$ref` hid the definition description, but a change of that hidden description still showed.
- `lineOf` missed number keys, for example an unquoted status code `200`.
- Smaller items: array items of their own definition, hidden readOnly properties that built definitions, a duplicate helper, and a misplaced doc comment.

What the Stripe run found after the fixes:

- The cycle fix was correct, but it made the output larger. In Stripe, almost every schema reaches the changed `customer` schema. So "expand each schema with a change inside" expanded almost everything: 4 million lines.
- The old output (762,000 lines) was smaller only because of the cycle bug.
- Fix: a large endpoint now shows only the shortest reference paths to its changes, and counts the unchanged nodes. Result: 320,000 lines, median 515 per endpoint, 2.8 seconds.
- `appendPointer` parsed the whole pointer again for each child. It now appends to the string. The Stripe self-diff went from 8.8 back to 3.8 seconds.

Reflection:

- A correctness fix can change the output size. I now run the Stripe diff after each change to the renderer or the impact logic, and I compare the line count, not only the time.
- A large test spec is part of the test suite in spirit. A committed snapshot test now covers the large-endpoint rule.

## M9 Located values

The user asked for lower-level primitives that make the code simpler, with the same or better performance.

Result:

- `Located` (`src/load/located.ts`) is a value with its file and JSON pointer. `at()` steps to a child. The pointer text is built on first use.
- `Located` replaced the `Loc` type of `build.ts`, the `Located` interface of `schema.ts`, the `Target` type of the store, and the pointer helpers. `json-pointer.ts` is gone.
- `DocumentStore.resolve(loc)` replaced `deref(node, file)`. It returns the target as a `Located`, or the reference that did not resolve.
- One `follow()` function in the model resolves references and records the warning.
- The diff sets no impacts. `settleImpacts()` sets all of them, with one walk of each tree per round.
- `npm run docs:guide` downloads a pinned d2 release on first use and checks its SHA-256.
- All snapshots and the Stripe output stayed byte-identical. Build time and memory stayed the same. The diff stage got about 10% faster.

Reflection:

- Before the M8 review fixed `appendPointer`, pointer work was half of the build time. After that fix, the primitive gave no speed gain. Its gain is simplicity: 65 calls of pointer helpers are gone, and each build function takes one place instead of a value, a file, and a pointer.
- The first version of `Located` built its `id` on each call and allocated an extra object per step. The memory peak of the build was then 20% higher. A cached `id` and two plain fields fixed it. Next time, I measure a new primitive on the large spec before I use it everywhere.
- Timings taken while another agent ran tests were off by a factor of five. I now compare the old and the new code in alternating runs on a quiet machine.
- Decision: tweak, no re-implementation.
