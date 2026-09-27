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
import { LineCounter, isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import type { Document as YamlDocument } from 'yaml';
import { InputError } from '../errors.ts';
import { refString, tryDecode } from '../util.ts';
import { getByParts, partsToPointer, pointerToParts } from './json-pointer.ts';

/** The target of a resolved `$ref`, or the node itself when it is not a reference. */
export interface Resolved {
    value: unknown;
    /** Absolute path of the file that holds `value`. */
    file: string;
    /** Identity of the target (`<file>#<pointer>`). Set when the node was a reference. */
    key?: string;
    /** JSON pointer of the target in `file`, for example `#/components/schemas/Pet`. Set when the node was a reference. */
    pointer?: string;
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
    pointer: string;
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
    /** Files whose references {@link loadWithRefs} already followed. */
    private readonly walked = new Set<string>();
    /** The text of each loaded file, for {@link lineOf}. */
    private readonly texts = new Map<string, string>();
    /** Parsed YAML documents with positions, built on the first {@link lineOf} call for a file. */
    private readonly positions = new Map<string, { doc: YamlDocument; lineCounter: LineCounter }>();
    private readonly readText: ReadText;
    /** How to name a file in messages, for example relative to the current folder. */
    readonly display: (path: string) => string;

    constructor(options: { readText?: ReadText; display?: (path: string) => string } = {}) {
        this.readText = options.readText ?? ((path) => readFile(path, 'utf8'));
        this.display = options.display ?? ((path) => path);
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
            const code = (err as NodeJS.ErrnoException).code;
            throw new InputError(`${this.display(file)}: ${code === 'ENOENT' ? 'file not found' : `cannot read file (${code ?? String(err)})`}`);
        }
        const root = parseSpecText(text, this.display(file));
        this.docs.set(file, root);
        this.texts.set(file, text);
        return root;
    }

    /**
     * Load a root file and every file that its `$ref`s reach. The root must
     * load. A referenced file that fails to load leaves its references
     * unresolved, and {@link deref} reports the reason.
     */
    async loadWithRefs(path: string): Promise<void> {
        const queue = [resolve(path)];
        await this.load(queue[0]);
        while (queue.length > 0) {
            const file = queue.shift()!;
            // Several root documents often share files. Walk each file's references once per store.
            if (this.walked.has(file)) {
                continue;
            }
            this.walked.add(file);
            for (const target of externalRefFiles(this.docs.get(file), file)) {
                if (this.failures.has(target)) {
                    continue;
                }
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
        const pointer = parts.length > 0 ? partsToPointer(parts) : '#';
        return {
            value,
            file,
            key: `${file}${pointer}`,
            pointer,
            name: parts.length > 0 ? parts[parts.length - 1] : basename(file, extname(file)),
        };
    }

    /**
     * The 1-based line of the node at `pointer` in a loaded file: the line of
     * its key for a map entry, or of the item for a list entry. `undefined`
     * when the file or the node is not there. The first call per file parses
     * the text again, with positions.
     */
    lineOf(path: string, pointer: string): number | undefined {
        const file = resolve(path);
        const text = this.texts.get(file);
        if (text === undefined) {
            return undefined;
        }
        let parsed = this.positions.get(file);
        if (parsed === undefined) {
            const lineCounter = new LineCounter();
            parsed = { doc: parseDocument(text, { lineCounter, merge: true, uniqueKeys: false }), lineCounter };
            this.positions.set(file, parsed);
        }
        // Walk by hand: `getIn` compares keys by value, so it misses the number key 200 for the part "200".
        let node: unknown = parsed.doc.contents;
        let offset: number | undefined = 0;
        for (const part of pointerToParts(pointer)) {
            if (isAlias(node)) {
                node = node.resolve(parsed.doc);
            }
            if (isMap(node)) {
                const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === part);
                offset = isScalar(pair?.key) ? pair.key.range?.[0] : undefined;
                node = pair?.value;
            } else if (isSeq(node)) {
                node = node.items[Number(part)];
                offset = isNode(node) ? node.range?.[0] : undefined;
            } else {
                return undefined;
            }
        }
        return offset === undefined ? undefined : parsed.lineCounter.linePos(offset).line;
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
