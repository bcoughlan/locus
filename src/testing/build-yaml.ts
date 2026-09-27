/** Test helper: build a document model from YAML text held in memory. */
import { resolve } from 'node:path';
import { DocumentStore } from '../load/documents.ts';
import { detectVersion } from '../load/version.ts';
import { buildDocument } from '../model/build.ts';
import type { DocumentModel, ViewNode } from '../model/tree.ts';

const ROOT = resolve('/virtual/api.yml');

/** Build a document from YAML text. `files` holds other files, relative to the root's folder. */
export async function buildYaml(yaml: string, files: Record<string, string> = {}): Promise<DocumentModel> {
    const texts = new Map([[ROOT, yaml], ...Object.entries(files).map(([name, text]) => [resolve('/virtual', name), text] as const)]);
    const store = new DocumentStore({
        readText: async (path) => {
            const text = texts.get(path);
            if (text === undefined) {
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            }
            return text;
        },
    });
    await store.loadWithRefs(ROOT);
    return buildDocument(store, ROOT, detectVersion(store.document(ROOT), ROOT)!);
}

/** A 3.1 document with `paths` given as YAML (indented under `paths:`) and optional top-level YAML. */
export function spec(paths: string, rest = '', version = '3.1.0'): string {
    return `openapi: ${version}\ninfo: {title: Test, version: '1'}\npaths:\n${paths}\n${rest}`;
}

/** The child at a path of keys, for example `find(op, 'request', 'query', 'limit')`. */
export function find<T extends { key: string; children: T[] }>(node: T, ...keys: string[]): T {
    let current = node;
    for (const key of keys) {
        const next = current.children.find((child) => child.key === key);
        if (next === undefined) {
            throw new Error(`No child "${key}" under "${current.key}". Children: ${current.children.map((c) => c.key).join(', ')}`);
        }
        current = next;
    }
    return current;
}

export const childKeys = (node: ViewNode | { children: { key: string }[] }) => node.children.map((child) => child.key);
