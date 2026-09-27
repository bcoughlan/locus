import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withDir } from 'tmp-promise';
import { describe, expect, test } from 'vitest';
import { expandPatterns, pairById, staticPrefix } from './files.ts';

async function withFiles(files: string[], fn: (root: string) => Promise<void>): Promise<void> {
    await withDir(
        async ({ path }) => {
            for (const file of files) {
                await mkdir(dirname(join(path, file)), { recursive: true });
                await writeFile(join(path, file), 'openapi: 3.1.0');
            }
            await fn(path);
        },
        { unsafeCleanup: true },
    );
}

const ids = (files: { id: string }[]) => files.map((f) => f.id);

describe('expandPatterns', () => {
    test('a glob matches files, with ids relative to the static part of the pattern', async () => {
        await withFiles(['specs/a.yml', 'specs/b.yml', 'specs/c.json', 'other/d.yml'], async (root) => {
            const files = await expandPatterns(['specs/*.yml'], root);
            expect(ids(files)).toEqual(['a.yml', 'b.yml']);
            expect(files[0].display).toBe('specs/a.yml');
            expect(files[0].path).toBe(join(root, 'specs', 'a.yml'));
        });
    });

    test('a folder stands for all YAML and JSON files below it, except node_modules', async () => {
        await withFiles(['specs/a.yml', 'specs/v2/b.yaml', 'specs/c.json', 'specs/readme.md', 'specs/node_modules/x.yml'], async (root) => {
            expect(ids(await expandPatterns(['specs'], root))).toEqual(['a.yml', 'c.json', 'v2/b.yaml']);
        });
    });

    test('a single file has its name as id', async () => {
        await withFiles(['specs/a.yml'], async (root) => {
            expect(ids(await expandPatterns(['specs/a.yml'], root))).toEqual(['a.yml']);
        });
    });

    test('several patterns get ids relative to their common folder, without duplicates', async () => {
        await withFiles(['a/api.yml', 'b/api.yml'], async (root) => {
            expect(ids(await expandPatterns(['a/*.yml', 'b/*.yml', 'a/api.yml'], root))).toEqual(['a/api.yml', 'b/api.yml']);
        });
    });

    test('an existing path with glob characters is literal', async () => {
        await withFiles(['specs/api[v2].yml', 'specs/apiv.yml'], async (root) => {
            expect(ids(await expandPatterns(['specs/api[v2].yml'], root))).toEqual(['api[v2].yml']);
        });
    });

    test('a folder whose name starts with two dots is inside its parent', async () => {
        await withFiles(['specs/..draft/a.yml', 'specs/v1/b.yml'], async (root) => {
            expect(ids(await expandPatterns(['specs/..draft/*.yml', 'specs/v1/*.yml'], root))).toEqual(['..draft/a.yml', 'v1/b.yml']);
        });
    });

    test('a glob that matches nothing adds no files', async () => {
        await withFiles([], async (root) => {
            expect(await expandPatterns(['specs/*.yml'], root)).toEqual([]);
        });
    });

    test('a plain path that does not exist is an error', async () => {
        await withFiles([], async (root) => {
            await expect(expandPatterns(['missing.yml'], root)).rejects.toThrow('missing.yml: no such file or folder');
        });
    });
});

describe('staticPrefix', () => {
    test.each([
        ['specs/*.yml', 'specs'],
        ['specs/**/*.yml', 'specs'],
        ['*.yml', '.'],
        ['../old/specs/{a,b}.yml', '../old/specs'],
        ['/abs/*.yml', '/abs'],
    ])('%s -> %s', (pattern, prefix) => {
        expect(staticPrefix(pattern)).toBe(prefix);
    });
});

describe('pairById', () => {
    test('pairs by id and keeps unmatched items on their side', () => {
        const pairs = pairById([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]);
        expect(pairs).toEqual([
            { id: 'a', base: { id: 'a' } },
            { id: 'b', base: { id: 'b' }, head: { id: 'b' } },
            { id: 'c', head: { id: 'c' } },
        ]);
    });

    test('one explicit file on each side pairs whatever the names', () => {
        const old = { id: 'old.yml', explicit: true };
        const current = { id: 'new.yml', explicit: true };
        expect(pairById([old], [current])).toEqual([{ id: 'new.yml', base: old, head: current }]);
    });

    test('one glob match on each side pairs by name only', () => {
        const old = { id: 'a.yml', explicit: false };
        const current = { id: 'b.yml', explicit: false };
        expect(pairById([old], [current])).toEqual([
            { id: 'a.yml', base: old },
            { id: 'b.yml', head: current },
        ]);
    });
});
