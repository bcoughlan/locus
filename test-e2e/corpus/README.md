# Diff corpus

This folder holds end-to-end scenarios for `locus diff`. Each scenario is a pair of OpenAPI documents, a base version and a head version, plus the expected result. `test-e2e/corpus.test.ts` runs each scenario through `main()` and compares the output with a snapshot.

## Layout

```text
corpus/
  <area>/
    <scenario>/
      scenario.yml     # what the scenario tests, and the expected class
      base/api.yml     # base version (more files are allowed, for $ref tests)
      head/api.yml     # head version
      output.txt       # snapshot of the output, written by the test
```

The test runs this command in the scenario folder:

```sh
locus diff --no-color --source base head
```

## scenario.yml

```yaml
description: A required query parameter is added to GET /pets.
expect: breaking   # breaking | compatible | unchanged
```

- `breaking`: the diff contains at least one breaking change. The exit code is 1.
- `compatible`: the diff contains changes, and none is breaking. The exit code is 0.
- `unchanged`: the two versions have the same meaning, for example a 3.0 to 3.1 rewrite. The exit code is 0, and the output lists no change.

## Rules for new scenarios

- `docs/breaking-changes.md` decides the expected class.
- Keep each document small: one or two endpoints. Test one change per scenario, unless the scenario is about a combination.
- Each document must be valid OpenAPI (3.0, 3.1, or 3.2). The `openapi` field selects the version.
- Name the folder after the change, in kebab case, for example `required-query-param-added`.
- To update the snapshots after an intended output change, run `npx vitest run test-e2e/corpus.test.ts -u`, then review the diff of each `output.txt`.
