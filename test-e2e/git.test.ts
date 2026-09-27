/** Git mode: the base version comes from a git ref, the head version from the working tree. */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDir } from 'tmp-promise';
import { expect, test } from 'vitest';
import { inTmp, openapi, runLocus, writeFiles } from './helpers.ts';

/** Run git in `cwd` with an empty global configuration, so the test does not depend on the developer's setup. */
function git(cwd: string, home: string, ...args: string[]): void {
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
        stdio: 'pipe',
    });
}

const petsApi = (params: string) =>
    openapi(`  /pets:
    get:
      operationId: listPets
      parameters: [${params}]
      responses:
        '200':
          description: OK
          content: {application/json: {schema: {$ref: '../schemas/pet.yml'}}}`);

async function withRepo(fn: (repo: string, home: string) => Promise<void>): Promise<void> {
    await withDir(
        async ({ path: home }) => {
            await writeFile(join(home, 'gitconfig'), '');
            const repo = join(home, 'repo');
            await writeFiles(repo, {
                'services/specs/pets.yml': petsApi('{name: limit, in: query, schema: {type: integer}}'),
                'services/specs/users.yml': openapi("  /users: {get: {responses: {'200': {description: OK}}}}"),
                'services/schemas/pet.yml': 'type: object\nproperties: {name: {type: string}}',
            });
            git(repo, home, 'init', '-q', '-b', 'main');
            git(repo, home, 'add', '.');
            git(repo, home, 'commit', '-q', '-m', 'base');
            // The default base is origin/main.
            git(repo, home, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
            await fn(repo, home);
        },
        { unsafeCleanup: true },
    );
}

test('compares the working tree with origin/main, following $refs into files outside the pattern', async () => {
    await withRepo(async (repo, home) => {
        // Working tree edits: a required parameter, a changed shared schema, a new spec, a deleted spec.
        await writeFiles(repo, {
            'services/specs/pets.yml': petsApi('{name: limit, in: query, schema: {type: integer}}, {name: owner, in: query, required: true}'),
            'services/schemas/pet.yml': 'type: object\nproperties: {name: {type: string}, age: {type: integer}}',
            'services/specs/orders.yml': openapi("  /orders: {get: {responses: {'200': {description: OK}}}}"),
        });
        git(repo, home, 'rm', '-q', 'services/specs/users.yml');

        const result = await runLocus(['diff', '--no-color', 'specs/*.yml'], join(repo, 'services'));

        expect(result.stderr).toBe('');
        expect(result.code).toBe(1);
        expect(result.stdout).toContain('Comparing origin/main → working tree');
        expect(result.stdout).toContain('+ specs/orders.yml (new file)');
        expect(result.stdout).toContain('- specs/users.yml (deleted)');
        expect(result.stdout).toMatch(/^\+ +owner {2}any {2}required {2}\[breaking: required query parameter added\]$/m);
        expect(result.stdout).toMatch(/^\+ +age {2}integer$/m);
        expect(result.stdout).toContain('Endpoints: 1 changed with breaking changes, 0 changed compatibly, 1 added, 1 removed, 0 unchanged.');
    });
});

test('--base selects another ref, and a plain path that is new at that ref counts as added', async () => {
    await withRepo(async (repo) => {
        await writeFiles(repo, { 'services/specs/orders.yml': openapi("  /orders: {get: {responses: {'200': {description: OK}}}}") });
        const result = await runLocus(['diff', '--no-color', '--base', 'main', 'specs/pets.yml', 'specs/orders.yml'], join(repo, 'services'));
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Comparing main → working tree');
        expect(result.stdout).toContain('+ specs/orders.yml (new file)');
        expect(result.stdout).not.toContain('specs/pets.yml');
    });
});

test('an unknown ref is an input error', async () => {
    await withRepo(async (repo) => {
        const result = await runLocus(['diff', '--base', 'nope', 'services/specs'], repo);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('error: unknown git ref "nope"');
    });
});

test('outside a git repository, git mode is an input error', async () => {
    await inTmp({ 'api.yml': openapi("  /a: {get: {responses: {'200': {description: OK}}}}") }, async (path) => {
        const result = await runLocus(['diff', 'api.yml'], path);
        expect(result.code).toBe(2);
        expect(result.stderr).toMatch(/error: .* is not inside a git repository\. Use --source to compare local files\./);
    });
});
