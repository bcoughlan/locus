import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDir } from 'tmp-promise';
import { expect, test } from 'vitest';
import { writeHelloWorld } from './hello-world.ts';

test('writes the greeting to the given file', async () => {
    await withDir(
        async ({ path }) => {
            const file = join(path, 'hello-world');
            await writeHelloWorld(file);
            expect(await readFile(file, 'utf8')).toBe('Hello, world!\n');
        },
        { unsafeCleanup: true },
    );
});
