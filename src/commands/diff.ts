/** `locus diff`: compare OpenAPI documents with a base version and report breaking changes. */
import { compareFiles } from '../compare.ts';
import type { Comparison } from '../compare.ts';
import { InputError } from '../errors.ts';
import { renderConsole } from '../render/console.ts';
import type { ColorLevel } from '../render/console.ts';
import { expandPatterns } from '../sources/files.ts';
import type { SpecFile } from '../sources/files.ts';
import { checkoutRef, keyByPath } from '../sources/git.ts';

export interface DiffCommandOptions {
    /** Git ref of the base version. */
    base?: string;
    /** Local files of the base version, instead of git. */
    source: string[];
    all: boolean;
    color: ColorLevel;
}

export interface CommandIo {
    stdout: (text: string) => void;
    cwd: string;
}

export const DEFAULT_BASE = 'origin/main';

/** Run the diff and print the report. Returns the exit code: 1 when there are breaking changes. */
export async function runDiff(patterns: string[], options: DiffCommandOptions, io: CommandIo): Promise<number> {
    const head = await expandPatterns(patterns, io.cwd);
    const { report, documents } =
        options.source.length > 0 ? await compareWithFolder(head, patterns, options.source, io.cwd) : await compareWithGit(head, patterns, options.base ?? DEFAULT_BASE, io.cwd);
    if (documents.head === 0) {
        throw new InputError(`No OpenAPI documents found in ${patterns.join(' ')}`);
    }
    io.stdout(renderConsole(report, { color: options.color, all: options.all }));
    return report.breaking ? 1 : 0;
}

/**
 * The base is local files. A base without OpenAPI documents is a mistake
 * (for example a wrong file extension in the pattern): comparing with it
 * would report every head document as new.
 */
async function compareWithFolder(head: SpecFile[], patterns: string[], source: string[], cwd: string): Promise<Comparison> {
    const comparison = await compareFiles(await expandPatterns(source, cwd), head, {
        baseLabel: source.join(' '),
        headLabel: patterns.join(' '),
        cwd: { base: cwd, head: cwd },
    });
    if (comparison.documents.base === 0) {
        throw new InputError(`No OpenAPI documents found in --source ${source.join(' ')}`);
    }
    return comparison;
}

/** The head is the working tree. The base is the same patterns at a git ref. The base can be empty: the documents are new. */
async function compareWithGit(head: SpecFile[], patterns: string[], ref: string, cwd: string): Promise<Comparison> {
    const checkout = await checkoutRef(ref, patterns, cwd);
    try {
        return await compareFiles(checkout.files, keyByPath(head, cwd), { baseLabel: ref, headLabel: 'working tree', cwd: { base: checkout.cwd, head: cwd } });
    } finally {
        await checkout.cleanup();
    }
}
