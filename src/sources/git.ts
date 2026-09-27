/**
 * Git mode: copies the base version of the spec files from a git ref into a
 * temporary folder. After that, git mode runs the same folder comparison as
 * `--source`.
 *
 * The copy mirrors the repository layout, so relative paths and `$ref`s work
 * the same as in the working tree. It holds the files that the patterns match
 * at the ref, plus every file that their `$ref`s reach.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, matchesGlob, posix, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { dir } from 'tmp-promise';
import { InputError } from '../errors.ts';
import { externalRefFiles, parseSpecText } from '../load/documents.ts';
import { FOLDER_PATTERN, SKIPPED_FOLDERS, expandPatterns, isGlobPattern, isInside, toPosix } from './files.ts';
import type { SpecFile } from './files.ts';

const run = promisify(execFile);

export interface GitCheckout {
    /**
     * The spec files at the ref. Their ids and display names are paths relative
     * to the current folder, the same as for working-tree files keyed with
     * {@link byDisplayPath}, so both sides pair even when a pattern matches on
     * one side only.
     */
    files: SpecFile[];
    /** The folder in the copy that stands for the current folder. */
    cwd: string;
    cleanup: () => Promise<void>;
}

/** Key files by their path relative to the current folder, as {@link GitCheckout.files} are. */
export function byDisplayPath(files: SpecFile[]): SpecFile[] {
    return files.map((file) => ({ ...file, id: file.display }));
}

/** Copy the files that `patterns` (relative to `cwd`) match at `ref` into a temporary folder. */
export async function checkoutRef(ref: string, patterns: string[], cwd: string): Promise<GitCheckout> {
    const root = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
    await verifyRef(ref, cwd);
    const tree = new Set((await git(['ls-tree', '-r', '-z', '--name-only', ref], root)).split('\0').filter(Boolean));

    const wanted = new Set<string>();
    // A plain path that does not exist at the ref is a new file: leave it out of the base.
    const existing: string[] = [];
    for (const pattern of patterns) {
        const matches = matchTree(tree, toRepoPath(pattern, cwd, root));
        if (matches.length > 0 || isGlobPattern(pattern)) {
            existing.push(pattern);
        }
        matches.forEach((file) => wanted.add(file));
    }

    const tmp = await dir({ prefix: 'locus-', unsafeCleanup: true });
    try {
        await copyWithRefs(ref, root, tmp.path, tree, [...wanted]);
        const copyCwd = join(tmp.path, relative(root, cwd));
        return { files: byDisplayPath(await expandPatterns(existing, copyCwd)), cwd: copyCwd, cleanup: tmp.cleanup };
    } catch (err) {
        await tmp.cleanup();
        throw err;
    }
}

/**
 * Copy files from the ref, then the files that their `$ref`s name, until no
 * new file turns up. Each round reads its files with one git process.
 */
async function copyWithRefs(ref: string, root: string, target: string, tree: Set<string>, files: string[]): Promise<void> {
    const copied = new Set<string>();
    let round = files;
    while (round.length > 0) {
        round.forEach((file) => copied.add(file));
        const next = new Set<string>();
        for (const [file, content] of await readBlobs(ref, round, root)) {
            const path = join(target, ...file.split('/'));
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, content);
            let doc: unknown;
            try {
                doc = parseSpecText(content.toString('utf8'), path);
            } catch {
                continue; // The comparison reports the parse error.
            }
            for (const referenced of externalRefFiles(doc, path)) {
                const repoPath = toPosix(relative(target, referenced));
                if (tree.has(repoPath) && !copied.has(repoPath)) {
                    next.add(repoPath);
                }
            }
        }
        round = [...next];
    }
}

/** Read files at a ref with one `git cat-file --batch` process. A file that does not exist is left out. */
async function readBlobs(ref: string, files: string[], root: string): Promise<Map<string, Buffer>> {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: root });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    const done = new Promise<void>((resolveDone, reject) => {
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolveDone() : reject(new InputError(`git cat-file failed: ${Buffer.concat(errors).toString('utf8').trim()}`))));
    });
    child.stdin.end(files.map((file) => `${ref}:${file}\n`).join(''));
    await done;

    // Each answer is "<oid> <type> <size>\n<content>\n", or "<name> missing\n".
    const out = Buffer.concat(chunks);
    const blobs = new Map<string, Buffer>();
    let pos = 0;
    for (const file of files) {
        const end = out.indexOf(0x0a, pos);
        const header = out.subarray(pos, end).toString('utf8');
        pos = end + 1;
        if (header.endsWith(' missing')) {
            continue;
        }
        const size = Number(header.split(' ')[2]);
        blobs.set(file, out.subarray(pos, pos + size));
        pos += size + 1;
    }
    return blobs;
}

/** A pattern relative to the repository root, with `/` separators. */
function toRepoPath(pattern: string, cwd: string, root: string): string {
    const glob = toPosix(pattern);
    const absolute = isAbsolute(glob) ? glob : resolve(cwd, glob);
    if (!isInside(absolute, root)) {
        throw new InputError(`${pattern}: outside the git repository ${root}`);
    }
    return posix.normalize(toPosix(relative(root, absolute)));
}

/** Files of the tree that a pattern selects: a glob, a file, or a folder (its YAML and JSON files). */
function matchTree(tree: Set<string>, pattern: string): string[] {
    if (tree.has(pattern)) {
        return [pattern];
    }
    const glob = isGlobPattern(pattern) ? pattern : `${pattern === '.' ? '' : `${pattern}/`}${FOLDER_PATTERN}`;
    return [...tree].filter((file) => !file.split('/').some((segment) => SKIPPED_FOLDERS.has(segment)) && matchesGlob(file, glob));
}

async function verifyRef(ref: string, cwd: string): Promise<void> {
    try {
        await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    } catch {
        throw new InputError(`unknown git ref "${ref}". Fetch it first (for example: git fetch origin main), or pass another ref with --base.`);
    }
}

async function git(args: string[], cwd: string): Promise<string> {
    try {
        const { stdout } = await run('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
        return stdout;
    } catch (err) {
        const error = err as NodeJS.ErrnoException & { stderr?: string };
        if (error.code === 'ENOENT') {
            throw new InputError('git is not installed or not on the PATH. Use --source to compare local files.');
        }
        const message = error.stderr?.trim() || error.message;
        if (/not a git repository/i.test(message)) {
            throw new InputError(`${cwd} is not inside a git repository. Use --source to compare local files.`);
        }
        throw new InputError(`git ${args.join(' ')} failed: ${message}`);
    }
}
