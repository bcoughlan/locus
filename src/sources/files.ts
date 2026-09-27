/**
 * Turns command-line arguments (files, folders, and glob patterns) into spec
 * files, and pairs base files with head files.
 */
import { glob, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { InputError } from '../errors.ts';

export interface SpecFile {
    /** Pairing key: the path relative to the common folder of all patterns, with `/` separators. */
    id: string;
    /** Absolute path. */
    path: string;
    /** Name to show the user, for example `specs/petstore.yml`. */
    display: string;
    /** The user named this file directly, not through a folder or a glob. */
    explicit: boolean;
}

export interface FilePair<T> {
    id: string;
    base?: T;
    head?: T;
}

/** The files that a folder argument stands for. */
const FOLDER_PATTERN = '**/*.{yml,yaml,json}';
const SKIPPED_FOLDERS = new Set(['node_modules', '.git']);

/**
 * Expand patterns relative to `cwd`. A folder stands for the YAML and JSON
 * files below it. A pattern with glob characters that matches nothing adds no
 * files. A plain path that does not exist is an error.
 */
export async function expandPatterns(patterns: string[], cwd: string): Promise<SpecFile[]> {
    const bases: string[] = [];
    const found = new Map<string, boolean>(); // path -> explicit
    for (const raw of patterns) {
        const path = resolve(cwd, raw);
        // A path that exists is literal, even when its name contains glob characters.
        const stats = await stat(path).catch(() => undefined);
        if (stats === undefined) {
            const pattern = toPosix(raw);
            if (!isGlobPattern(pattern)) {
                throw new InputError(`${raw}: no such file or folder`);
            }
            bases.push(resolve(cwd, staticPrefix(pattern)));
            await addGlobMatches(found, pattern, cwd);
        } else if (stats.isDirectory()) {
            bases.push(path);
            await addGlobMatches(found, FOLDER_PATTERN, path);
        } else {
            bases.push(dirname(path));
            found.set(path, true);
        }
    }
    const root = commonFolder(bases);
    return [...found]
        .map(([path, explicit]) => ({ id: toPosix(relative(root, path)), path, display: toPosix(relative(cwd, path)), explicit }))
        .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Pair base and head files by id. When each side is one file that the user
 * named directly, the two pair up whatever their names, so
 * `locus diff --source old.yml new.yml` works.
 */
export function pairById<T extends { id: string; explicit?: boolean }>(base: T[], head: T[]): FilePair<T>[] {
    if (base.length === 1 && head.length === 1 && base[0].explicit && head[0].explicit) {
        return [{ id: head[0].id, base: base[0], head: head[0] }];
    }
    const pairs = new Map<string, FilePair<T>>();
    for (const item of head) {
        pairs.set(item.id, { id: item.id, head: item });
    }
    for (const item of base) {
        const pair = pairs.get(item.id);
        if (pair) {
            pair.base = item;
        } else {
            pairs.set(item.id, { id: item.id, base: item });
        }
    }
    return [...pairs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function isGlobPattern(pattern: string): boolean {
    return /[*?[\]{}]/.test(pattern);
}

/** The folder part of a glob pattern before the first segment with glob characters. */
export function staticPrefix(pattern: string): string {
    const segments = pattern.split('/');
    const index = segments.findIndex(isGlobPattern);
    const prefix = segments.slice(0, index === -1 ? segments.length : index).join('/');
    return prefix === '' && pattern.startsWith('/') ? '/' : prefix || '.';
}

async function addGlobMatches(found: Map<string, boolean>, pattern: string, cwd: string): Promise<void> {
    const entries = glob(pattern, {
        cwd,
        withFileTypes: true,
        exclude: (entry) => SKIPPED_FOLDERS.has(entry.name),
    });
    for await (const entry of entries) {
        const path = join(entry.parentPath, entry.name);
        if (entry.isFile() && !found.has(path)) {
            found.set(path, false);
        }
    }
}

/** The deepest folder that contains all `folders`. */
function commonFolder(folders: string[]): string {
    if (folders.length === 0) {
        return '';
    }
    let common = folders[0];
    for (const folder of folders.slice(1)) {
        while (!isInside(folder, common)) {
            const parent = dirname(common);
            if (parent === common) {
                return common;
            }
            common = parent;
        }
    }
    return common;
}

function isInside(path: string, folder: string): boolean {
    const rel = relative(folder, path);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** `/` separators on every platform. Glob patterns and ids use them. */
function toPosix(path: string): string {
    return sep === '/' ? path : path.split(sep).join('/');
}
