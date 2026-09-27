/** Git mode: the base version comes from a git ref, the head version from the working tree. */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDir } from 'tmp-promise';
import { expect, test } from 'vitest';
import { inTmp, openapi, runLocus, transcript, writeFiles } from './helpers.ts';

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
        expect(transcript(result, home)).toMatchSnapshot();
    });
});

test('--base selects another ref, and a plain path that is new at that ref counts as added', async () => {
    await withRepo(async (repo, home) => {
        await writeFiles(repo, { 'services/specs/orders.yml': openapi("  /orders: {get: {responses: {'200': {description: OK}}}}") });
        const result = await runLocus(['diff', '--no-color', '--base', 'main', 'specs/pets.yml', 'specs/orders.yml'], join(repo, 'services'));
        expect(transcript(result, home)).toMatchSnapshot();
    });
});

test('an unknown ref is an input error', async () => {
    await withRepo(async (repo, home) => {
        const result = await runLocus(['diff', '--base', 'nope', 'services/specs'], repo);
        expect(transcript(result, home)).toMatchSnapshot();
    });
});

test('outside a git repository, git mode is an input error', async () => {
    await inTmp({ 'api.yml': openapi("  /a: {get: {responses: {'200': {description: OK}}}}") }, async (path) => {
        const result = await runLocus(['diff', 'api.yml'], path);
        expect(transcript(result, path)).toMatchSnapshot();
    });
});
