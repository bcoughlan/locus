/**
 * Git mode: copies the base version of the spec files from a git ref into a
 * temporary folder. After that, git mode runs the same folder comparison as
 * `--source`.
 *
 * The copy mirrors the repository layout, so relative paths and `$ref`s work
 * the same as in the working tree. It holds the files that the patterns match
 * at the ref, plus every file that their `$ref`s reach.
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, matchesGlob, posix, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { dir } from 'tmp-promise';
import { InputError } from '../errors.ts';
import { externalRefFiles, parseSpecText } from '../load/documents.ts';
import { isGlobPattern } from './files.ts';

const run = promisify(execFile);

export interface GitCheckout {
    /** The folder in the copy that stands for the current folder. Resolve the patterns against it. */
    cwd: string;
    /** The patterns that exist at the ref. A plain path that does not exist there is a new file, so it drops out. */
    patterns: string[];
    cleanup: () => Promise<void>;
}

/** Copy the files that `patterns` (relative to `cwd`) match at `ref` into a temporary folder. */
export async function checkoutRef(ref: string, patterns: string[], cwd: string): Promise<GitCheckout> {
    const root = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
    await verifyRef(ref, cwd);
    const tree = new Set((await git(['ls-tree', '-r', '-z', '--name-only', ref], root)).split('\0').filter(Boolean));

    const wanted = new Set<string>();
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
    } catch (err) {
        await tmp.cleanup();
        throw err;
    }
    return { cwd: join(tmp.path, relative(root, cwd)), patterns: existing, cleanup: tmp.cleanup };
}

/** Copy files from the ref, then the files that their `$ref`s name, until no new file turns up. */
async function copyWithRefs(ref: string, root: string, target: string, tree: Set<string>, files: string[]): Promise<void> {
    const copied = new Set<string>();
    const queue = [...files];
    while (queue.length > 0) {
        const file = queue.shift()!;
        if (copied.has(file)) {
            continue;
        }
        copied.add(file);
        const content = await gitBuffer(['show', `${ref}:${file}`], root);
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
            const repoPath = relative(target, referenced).split(/[\\/]/).join('/');
            if (tree.has(repoPath) && !copied.has(repoPath)) {
                queue.push(repoPath);
            }
        }
    }
}

/** A pattern relative to the repository root, with `/` separators. */
function toRepoPath(pattern: string, cwd: string, root: string): string {
    const glob = pattern.replace(/\\/g, '/');
    const absolute = isAbsolute(glob) ? glob : resolve(cwd, glob);
    const rel = relative(root, absolute).split(/[\\/]/).join('/');
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
        throw new InputError(`${pattern}: outside the git repository ${root}`);
    }
    return posix.normalize(rel);
}

/** Files of the tree that a pattern selects: a glob, a file, or a folder (its YAML and JSON files). */
function matchTree(tree: Set<string>, pattern: string): string[] {
    if (tree.has(pattern)) {
        return [pattern];
    }
    const glob = isGlobPattern(pattern) ? pattern : `${pattern === '.' ? '' : `${pattern}/`}**/*.{yml,yaml,json}`;
    return [...tree].filter((file) => !file.split('/').includes('node_modules') && matchesGlob(file, glob));
}

async function verifyRef(ref: string, cwd: string): Promise<void> {
    try {
        await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    } catch {
        throw new InputError(`unknown git ref "${ref}". Fetch it first (for example: git fetch origin main), or pass another ref with --base.`);
    }
}

async function git(args: string[], cwd: string): Promise<string> {
    return (await gitBuffer(args, cwd)).toString('utf8');
}

async function gitBuffer(args: string[], cwd: string): Promise<Buffer> {
    try {
        const { stdout } = await run('git', args, { cwd, encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
        return stdout;
    } catch (err) {
        const error = err as NodeJS.ErrnoException & { stderr?: Buffer };
        if (error.code === 'ENOENT') {
            throw new InputError('git is not installed or not on the PATH. Use --source to compare local files.');
        }
        const message = error.stderr?.toString('utf8').trim() || error.message;
        if (/not a git repository/i.test(message)) {
            throw new InputError(`${cwd} is not inside a git repository. Use --source to compare local files.`);
        }
        throw new InputError(`git ${args.join(' ')} failed: ${message}`);
    }
}
