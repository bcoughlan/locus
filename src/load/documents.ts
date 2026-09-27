/**
 * Loads spec files from disk and resolves `$ref`s across them.
 *
 * Model building is synchronous, so {@link DocumentStore.loadWithRefs} first
 * loads a root document and, transitively, every file that its `$ref`s name.
 * {@link DocumentStore.deref} then resolves references from the cache. A
 * reference resolves against the file it appears in, not against the root.
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { InputError } from '../errors.ts';
import { refString, tryDecode } from '../util.ts';
import { getByParts, partsToPointer, pointerToParts } from './json-pointer.ts';

/** The target of a resolved `$ref`, or the node itself when it is not a reference. */
export interface Resolved {
    value: unknown;
    /** Absolute path of the file that holds `value`. */
    file: string;
    /** Identity of the target (`<file>#<pointer>`), for cycle detection. Set when the node was a reference. */
    key?: string;
    /** Name of the target: the last pointer token (`Pet` for `#/components/schemas/Pet`), or the file name. */
    name?: string;
    /** The reference that failed to resolve. `value` is then `undefined`. */
    unresolved?: string;
    /** Why the file of an unresolved reference did not load. */
    reason?: string;
}

interface Target {
    value: unknown;
    file: string;
    key: string;
    name: string;
}

export type ReadText = (path: string) => Promise<string>;

/** Parse YAML or JSON text. Throws {@link InputError} on a syntax error. */
export function parseSpecText(text: string, file: string): unknown {
    if (file.toLowerCase().endsWith('.json')) {
        try {
            return JSON.parse(text);
        } catch {
            // Fall through: the YAML parser reports the position of the error.
        }
    }
    // Real-world specs contain YAML merge keys (`<<`) and duplicate keys. Accept both.
    const doc = parseDocument(text, { merge: true, uniqueKeys: false });
    if (doc.errors.length > 0) {
        throw new InputError(`${file}: ${doc.errors[0].message}`);
    }
    try {
        // Specs reuse anchors a lot, so lift the alias limit (100 by default).
        return doc.toJS({ maxAliasCount: -1 });
    } catch (err) {
        throw new InputError(`${file}: ${(err as Error).message}`);
    }
}

/**
 * The file that a `$ref` names (absolute) and the pointer tokens into it.
 * `undefined` for references that the tool does not support: remote URLs and
 * `$anchor` fragments (`#name`).
 */
export function parseRef(ref: string, fromFile: string): { file: string; parts: string[] } | undefined {
    const hash = ref.indexOf('#');
    const filePart = hash === -1 ? ref : ref.slice(0, hash);
    const fragment = hash === -1 ? '' : ref.slice(hash + 1);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filePart) || (fragment !== '' && !fragment.startsWith('/'))) {
        return undefined;
    }
    const file = filePart === '' ? fromFile : resolve(dirname(fromFile), tryDecode(decodeURI, filePart));
    return { file, parts: pointerToParts(fragment) };
}

export class DocumentStore {
    private readonly docs = new Map<string, unknown>();
    /** Referenced files that did not load, with the reason. */
    private readonly failures = new Map<string, string>();
    /** Resolved references by `<from file>\0<ref>`. Documents never change after loading. */
    private readonly targets = new Map<string, Target | undefined>();
    private readonly readText: ReadText;

    constructor(readText: ReadText = (path) => readFile(path, 'utf8')) {
        this.readText = readText;
    }

    /** Load and cache one file. Throws {@link InputError} when the file is missing or does not parse. */
    async load(path: string): Promise<unknown> {
        const file = resolve(path);
        if (this.docs.has(file)) {
            return this.docs.get(file);
        }
        let text: string;
        try {
            text = await this.readText(file);
        } catch (err) {
            throw new InputError(`${file}: cannot read file (${(err as NodeJS.ErrnoException).code ?? String(err)})`);
        }
        const root = parseSpecText(text, file);
        this.docs.set(file, root);
        return root;
    }

    /**
     * Load a root file and every file that its `$ref`s reach. The root must
     * load. A referenced file that fails to load leaves its references
     * unresolved, and {@link deref} reports the reason.
     */
    async loadWithRefs(path: string): Promise<void> {
        const queue = [resolve(path)];
        const seen = new Set(queue);
        await this.load(queue[0]);
        while (queue.length > 0) {
            const file = queue.shift()!;
            for (const target of externalRefFiles(this.docs.get(file), file)) {
                if (seen.has(target)) {
                    continue;
                }
                seen.add(target);
                try {
                    await this.load(target);
                    queue.push(target);
                } catch (err) {
                    this.failures.set(target, (err as Error).message);
                }
            }
        }
    }

    /** A loaded document, or `undefined` when the file is not loaded. */
    document(path: string): unknown {
        return this.docs.get(resolve(path));
    }

    /**
     * Follow `node` when it is a `$ref`, through chains of references, to the
     * target value. A node that is not a reference resolves to itself.
     */
    deref(node: unknown, file: string): Resolved {
        let current: Resolved = { value: node, file };
        let name: string | undefined;
        const chain = new Set<string>();
        for (let ref = refString(node); ref !== undefined; ref = refString(current.value)) {
            const target = this.target(ref, current.file);
            if (target === undefined || chain.has(target.key)) {
                const reason = this.failures.get(parseRef(ref, current.file)?.file ?? '');
                return { value: undefined, file: current.file, unresolved: ref, ...(reason && { reason }) };
            }
            chain.add(target.key);
            name ??= target.name;
            current = target;
        }
        return name === undefined ? current : { ...current, name };
    }

    /** Resolve one reference string, without following chains. */
    private target(ref: string, fromFile: string): Target | undefined {
        const cacheKey = `${fromFile}\0${ref}`;
        if (!this.targets.has(cacheKey)) {
            this.targets.set(cacheKey, this.lookup(ref, fromFile));
        }
        return this.targets.get(cacheKey);
    }

    private lookup(ref: string, fromFile: string): Target | undefined {
        const parsed = parseRef(ref, fromFile);
        if (parsed === undefined || !this.docs.has(parsed.file)) {
            return undefined;
        }
        const { file, parts } = parsed;
        const value = getByParts(this.docs.get(file), parts);
        if (value === undefined) {
            return undefined;
        }
        return {
            value,
            file,
            key: `${file}${partsToPointer(parts)}`,
            name: parts.length > 0 ? parts[parts.length - 1] : basename(file, extname(file)),
        };
    }
}

/**
 * Absolute paths of the files that the `$ref`s in `root` point to. This walks
 * every value, example data included, because a schema property can have any
 * name. A `$ref` in example data can name a file that does not exist; the
 * loader then ignores it.
 */
export function externalRefFiles(root: unknown, file: string): Set<string> {
    const files = new Set<string>();
    const stack: unknown[] = [root];
    const visited = new Set<object>();
    while (stack.length > 0) {
        const node = stack.pop();
        if (node === null || typeof node !== 'object' || visited.has(node)) {
            continue;
        }
        visited.add(node);
        const ref = refString(node);
        const target = ref === undefined ? undefined : parseRef(ref, file)?.file;
        if (target !== undefined && target !== file) {
            files.add(target);
        }
        for (const value of Object.values(node)) {
            stack.push(value);
        }
    }
    return files;
}
