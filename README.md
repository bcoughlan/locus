# locus-cli

Toolbox for validating and comparing OpenAPI changes.

`locus diff` compares two versions of your OpenAPI documents. It prints each changed endpoint in full, like API documentation, and marks each change. Green marks an addition, orange a compatible change, and red a breaking change. The command exits with code 1 when it finds a breaking change, so it can gate a pull request.

It supports OpenAPI 3.0, 3.1, and 3.2. Swagger 2.0 is not supported.

## Install

```sh
npm install --save-dev locus-cli
```

locus-cli needs Node.js 24.8 or later.

## Usage

Compare the working tree with `origin/main`:

```sh
npx locus diff "specs/*.yml"
```

Compare with another git ref:

```sh
npx locus diff --base v1.4.0 "specs/*.yml"
```

Compare two local folders, or two single files:

```sh
npx locus diff --source ../old/specs specs
npx locus diff --source api-v1.yml api-v2.yml
```

Put glob patterns in quotes. If the shell expands them, a file that exists only at the base ref is not found.

| Option | Meaning |
| --- | --- |
| `--base <ref>` | The git ref of the base version. The default is `origin/main`. |
| `--source <pattern>` | Take the base version from local files: a file, a folder, or a glob pattern. You can repeat it. |
| `--all` | Also print the endpoints that did not change. |
| `--no-color` | Print without colors. The tool also honors `NO_COLOR` and `FORCE_COLOR`. |

A folder argument stands for all `.yml`, `.yaml`, and `.json` files below it. Files without an `openapi` field, such as shared schema files, are not compared on their own. Their content is compared through the `$ref`s that point to them.

The tool pairs base and head documents by their path below the pattern folder. In git mode, it copies the base files and every file that their `$ref`s reach into a temporary folder, and then compares the two folders.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | No breaking change. |
| 1 | At least one breaking change. |
| 2 | Usage error or input error, for example a file that does not parse. |

## Output

```text
~   GET /pets  listPets  [breaking]
      List pets
      Security
        api_key  apiKey in header "X-API-Key"
      Request
        Query parameters
~         limit  integer<int32>  <= 100
            How many pets to return
~           maximum: 500 → 100  [breaking: maximum decreased (client sends)]
~         status  string
            Allowed values: available, sold, pending
~           enum: + pending
+       Header parameters
+         X-Request-Id  string<uuid>  required  [breaking: required header parameter added (client sends)]
      Responses
        200  A page of pets
          application/json  array[Pet]
            name  string  required  <= 50 characters
            tag  string | null
+           age  integer  >= 0
+             Age in years
```

The first column marks each line: `+` added, `-` removed, `~` changed. A breaking change carries a `[breaking: reason]` tag, so the output keeps all information without colors. "Client sends" and "client receives" say which direction decided the class.

## What counts as breaking

`docs/breaking-changes.md` lists every rule. The short version: a value that the client sends can accept more over time, but not less. A value that the client receives can promise more over time, but not less. For webhooks and callbacks, the API sends the request, so the directions flip.

## Limits

- The tool does not follow remote references (`https://...`) or `$anchor` references. It warns about them.
- In a large endpoint (more than 400 printed lines), the output shows only the shortest paths to the changes. Unchanged parts show as a count, for example `… 12 unchanged, not shown`. A schema that already printed shows `(shown above)`. The comparison itself always covers the whole spec.
- A change of a regular expression (`pattern`) always counts as breaking, because the tool cannot compare two patterns.

## Use as a library

```ts
import { compareFiles, expandPatterns, renderConsole } from 'locus-cli';

const base = await expandPatterns(['old/specs'], process.cwd());
const head = await expandPatterns(['specs'], process.cwd());
const { report } = await compareFiles(base, head, { baseLabel: 'old', headLabel: 'new' });
console.log(renderConsole(report, { color: 0, all: false }));
```

The report is a tree of plain objects (see `DiffReport` in `src/diff/report.ts`), so other renderers can use it.

## Development

```sh
npm install
npm run check                                # typecheck, lint, tests, build
node src/bin.ts diff --source old new        # run from source
npx vitest run test-e2e/corpus.test.ts -u    # update the output snapshots
```

`docs/PLAN.md` describes the design. `test-e2e/corpus/` holds 183 end-to-end scenarios with snapshots of the output.
