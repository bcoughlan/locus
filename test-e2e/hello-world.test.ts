import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDir } from 'tmp-promise';
import { expect, test } from 'vitest';
import { main } from '../src/main.ts';

test('locus hello-world writes the file and exits 0', async () => {
    await withDir(
        async ({ path }) => {
            const file = join(path, 'hello-world');
            let stdout = '';
            const code = await main(['hello-world', file], {
                stdout: (text) => (stdout += text),
                stderr: () => {},
            });
            expect(code).toBe(0);
            expect(stdout).toBe(`Wrote ${file}\n`);
            expect(await readFile(file, 'utf8')).toBe('Hello, world!\n');
        },
        { unsafeCleanup: true },
    );
});

test('an unknown command is a usage error (exit 2)', async () => {
    let stderr = '';
    const code = await main(['no-such-command'], { stdout: () => {}, stderr: (text) => (stderr += text) });
    expect(code).toBe(2);
    expect(stderr).toContain("unknown command 'no-such-command'");
});

test('--help exits 0', async () => {
    let stdout = '';
    const code = await main(['--help'], { stdout: (text) => (stdout += text), stderr: () => {} });
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: locus');
});
