import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { InputError } from '../errors.ts';
import { DocumentStore, externalRefFiles, parseRef, parseSpecText } from './documents.ts';
import type { Resolved } from './documents.ts';
import { Located } from './located.ts';

/** A store over in-memory files. Keys are paths relative to a virtual root. */
function memoryStore(files: Record<string, string>): DocumentStore {
    const byPath = new Map(Object.entries(files).map(([name, text]) => [resolve('/virtual', name), text]));
    return new DocumentStore({
        readText: async (path) => {
            const text = byPath.get(path);
            if (text === undefined) {
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            }
            return text;
        },
    });
}

const at = (name: string) => resolve('/virtual', name);

/** A value placed at the top of `api.yml`, for example a `$ref` object to resolve. */
const inline = (value: unknown) => Located.root(value, at('api.yml'));

function mustResolve(store: DocumentStore, loc: Located): Resolved {
    const resolved = store.resolve(loc);
    if (resolved.unresolved !== undefined) {
        throw new Error(`Unresolved: ${resolved.unresolved}`);
    }
    return resolved;
}

describe('parseSpecText', () => {
    test('parses YAML and JSON', () => {
        expect(parseSpecText('a: 1', 'x.yml')).toEqual({ a: 1 });
        expect(parseSpecText('{"a": [1, 2]}', 'x.json')).toEqual({ a: [1, 2] });
    });

    test('a .json file with YAML content still parses', () => {
        expect(parseSpecText('a: 1', 'x.json')).toEqual({ a: 1 });
    });

    test('supports YAML merge keys', () => {
        expect(parseSpecText('base: &b {x: 1}\nderived:\n  <<: *b\n  y: 2', 'x.yml')).toEqual({
            base: { x: 1 },
            derived: { x: 1, y: 2 },
        });
    });

    test('reports syntax errors with the file name', () => {
        expect(() => parseSpecText('a: [1, 2', 'broken.yml')).toThrow(InputError);
        expect(() => parseSpecText('a: [1, 2', 'broken.yml')).toThrow(/^broken\.yml: /);
    });
});

describe('parseRef', () => {
    test('splits the file and the pointer, relative to the referring file', () => {
        expect(parseRef('../common/pet.yml#/Pet', at('specs/api.yml'))).toEqual({ file: at('common/pet.yml'), parts: ['Pet'] });
        expect(parseRef('#/components/schemas/Pet', at('api.yml'))).toEqual({ file: at('api.yml'), parts: ['components', 'schemas', 'Pet'] });
        expect(parseRef('my%20pet.yml', at('api.yml'))).toEqual({ file: at('my pet.yml'), parts: [] });
    });

    test('remote URLs and $anchor fragments are not supported', () => {
        expect(parseRef('https://example.com/pet.yml', at('api.yml'))).toBeUndefined();
        expect(parseRef('#Pet', at('api.yml'))).toBeUndefined();
    });
});

describe('DocumentStore', () => {
    test('a missing root file is an input error', async () => {
        await expect(memoryStore({}).loadWithRefs(at('api.yml'))).rejects.toThrow(/api\.yml: file not found/);
    });

    test('resolves local refs and names the target', async () => {
        const store = memoryStore({ 'api.yml': 'components: {schemas: {Pet: {type: object}}}' });
        await store.loadWithRefs(at('api.yml'));
        const { target, name } = mustResolve(store, inline({ $ref: '#/components/schemas/Pet' }));
        expect(target.value).toEqual({ type: 'object' });
        expect(target.source).toEqual({ file: at('api.yml'), pointer: '#/components/schemas/Pet' });
        expect(name).toBe('Pet');
    });

    test('a value that is not a reference resolves to itself', async () => {
        const loc = inline({ type: 'string' });
        expect(memoryStore({}).resolve(loc)).toEqual({ target: loc });
    });

    test('loads referenced files transitively and resolves relative to the referring file', async () => {
        const store = memoryStore({
            'api.yml': 'schema: {$ref: "schemas/pet.yml#/Pet"}',
            'schemas/pet.yml': 'Pet: {properties: {owner: {$ref: "../common/owner.yml"}}}',
            'common/owner.yml': 'type: object',
        });
        await store.loadWithRefs(at('api.yml'));

        const pet = mustResolve(store, store.document(at('api.yml')).at('schema'));
        expect(pet.target.file).toBe(at('schemas/pet.yml'));
        expect(pet.name).toBe('Pet');

        const owner = mustResolve(store, pet.target.at('properties', 'owner'));
        expect(owner.target.value).toEqual({ type: 'object' });
        expect(owner.name).toBe('owner');
    });

    test('a ref into a missing file is unresolved, with the reason', async () => {
        const store = memoryStore({ 'api.yml': 'schema: {$ref: "missing.yml#/X"}' });
        await store.loadWithRefs(at('api.yml'));
        expect(store.resolve(inline({ $ref: 'missing.yml#/X' }))).toEqual({
            unresolved: 'missing.yml#/X',
            reason: `${at('missing.yml')}: file not found`,
        });
    });

    test('follows chains of refs and keeps the first name', async () => {
        const store = memoryStore({ 'api.yml': 'a: {$ref: "#/b"}\nb: {$ref: "#/c"}\nc: {type: string}' });
        await store.loadWithRefs(at('api.yml'));
        const { target, name } = mustResolve(store, inline({ $ref: '#/a' }));
        expect(target.value).toEqual({ type: 'string' });
        expect(name).toBe('a');
        expect(target.id).toBe(`${at('api.yml')}#/c`);
    });

    test('a cycle of pure refs is unresolved instead of looping', async () => {
        const store = memoryStore({ 'api.yml': 'a: {$ref: "#/b"}\nb: {$ref: "#/a"}' });
        await store.loadWithRefs(at('api.yml'));
        expect(store.resolve(inline({ $ref: '#/a' })).unresolved).toBe('#/a');
    });

    test('remote and anchor refs are unresolved', async () => {
        const store = memoryStore({ 'api.yml': 'a: {$ref: "https://example.com/pet.yml"}\nPet: {type: object}' });
        await store.loadWithRefs(at('api.yml'));
        expect(store.resolve(inline({ $ref: 'https://example.com/pet.yml' })).unresolved).toBe('https://example.com/pet.yml');
        expect(store.resolve(inline({ $ref: '#Pet' })).unresolved).toBe('#Pet');
    });

    test('decodes escaped pointer tokens', async () => {
        const store = memoryStore({ 'api.yml': 'paths: {"/pets/{id}": {x: 1}}' });
        await store.loadWithRefs(at('api.yml'));
        const { target } = mustResolve(store, inline({ $ref: '#/paths/~1pets~1%7Bid%7D' }));
        expect(target.value).toEqual({ x: 1 });
        expect(target.pointer).toBe('#/paths/~1pets~1{id}');
    });
});

describe('lineOf', () => {
    test('gives the line of a map key or a list item for a JSON pointer', async () => {
        const store = memoryStore({
            'api.yml': 'openapi: 3.1.0\npaths:\n  /pets:\n    get:\n      parameters:\n        - name: limit\n          in: query\n',
        });
        await store.loadWithRefs(at('api.yml'));
        expect(store.lineOf(at('api.yml'), '#')).toBe(1);
        expect(store.lineOf(at('api.yml'), '#/paths/~1pets/get')).toBe(4);
        expect(store.lineOf(at('api.yml'), '#/paths/~1pets/get/parameters/0')).toBe(6);
        expect(store.lineOf(at('api.yml'), '#/paths/~1pets/post')).toBeUndefined();
        expect(store.lineOf(at('other.yml'), '#')).toBeUndefined();
    });

    test('finds number keys, such as an unquoted status code', async () => {
        const store = memoryStore({
            'api.yml': 'openapi: 3.1.0\npaths:\n  /pets:\n    get:\n      responses:\n        200:\n          description: OK\n',
        });
        await store.loadWithRefs(at('api.yml'));
        expect(store.lineOf(at('api.yml'), '#/paths/~1pets/get/responses/200/description')).toBe(7);
    });

    test('works for JSON files too', async () => {
        const store = memoryStore({ 'api.json': '{\n  "openapi": "3.1.0",\n  "info": {\n    "title": "T"\n  }\n}' });
        await store.loadWithRefs(at('api.json'));
        expect(store.lineOf(at('api.json'), '#/info/title')).toBe(4);
    });
});

describe('externalRefFiles', () => {
    test('collects the files of external refs, relative to the file', () => {
        const doc = {
            a: { $ref: 'x.yml#/A' },
            b: [{ $ref: 'sub/y.json' }],
            c: { $ref: '#/local' },
            d: { $ref: 'http://h/z.yml' },
            properties: { value: { $ref: 'value.yml' } },
        };
        expect(externalRefFiles(doc, at('dir/api.yml'))).toEqual(
            new Set([at('dir/sub/y.json'), at('dir/x.yml'), at('dir/value.yml')]),
        );
    });
});
