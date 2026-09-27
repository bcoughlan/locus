/** E2E helpers: run the CLI in-process and capture what it prints. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { main } from '../src/main.ts';
import type { ColorLevel } from '../src/render/console.ts';

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

/** Write files below `root`. Keys are relative paths. */
export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
    for (const [name, text] of Object.entries(files)) {
        const path = join(root, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text);
    }
}

/** A minimal OpenAPI 3.1 document with the given paths (YAML, indented under `paths:`). */
export function openapi(paths: string, rest = ''): string {
    return `openapi: 3.1.0\ninfo: {title: Test API, version: '1.0'}\npaths:\n${paths}\n${rest}`;
}
