/** E2E helpers: run the CLI in-process and capture what it prints. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withDir } from 'tmp-promise';
import { main } from '../src/main.ts';
import type { ColorLevel } from '../src/render/console.ts';

export { spec as openapi } from '../src/testing/build-yaml.ts';

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** Run `locus <args>` in `cwd`. `color` is what the terminal supports (0: no colors, 3: truecolor). */
export async function runLocus(args: string[], cwd: string, color: ColorLevel = 0): Promise<RunResult> {
    const result = { code: 0, stdout: '', stderr: '' };
    result.code = await main(args, {
        stdout: (text) => (result.stdout += text),
        stderr: (text) => (result.stderr += text),
        cwd,
        color,
    });
    return result;
}

/**
 * A run as one text block for a snapshot: the exit code, stdout, and stderr.
 * `tmp` (a temporary folder) becomes `<tmp>`, so the snapshot is the same on every machine.
 */
export function transcript(result: RunResult, tmp?: string): string {
    const text = `exit code: ${result.code}\n--- stdout\n${result.stdout}--- stderr\n${result.stderr}`;
    if (tmp === undefined) {
        return text;
    }
    const variants = [tmp, tmp.replace(/\\/g, '/')];
    return variants.reduce((out, path) => out.split(path).join('<tmp>'), text).replace(/<tmp>[^\s]*/g, (path) => path.replace(/\\/g, '/'));
}

/** Write files below `root`. Keys are relative paths. */
export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
    for (const [name, text] of Object.entries(files)) {
        const path = join(root, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text);
    }
}

/** Run `fn` in a temporary folder that holds `files`, and delete the folder afterwards. */
export async function inTmp(files: Record<string, string>, fn: (dir: string) => Promise<void>): Promise<void> {
    await withDir(
        async ({ path }) => {
            await writeFiles(path, files);
            await fn(path);
        },
        { unsafeCleanup: true },
    );
}
