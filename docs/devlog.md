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
