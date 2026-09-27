import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { InputError } from '../errors.ts';
import { DocumentStore, externalRefFiles, parseRef, parseSpecText } from './documents.ts';

/** A store over in-memory files. Keys are paths relative to a virtual root. */
function memoryStore(files: Record<string, string>): DocumentStore {
    const byPath = new Map(Object.entries(files).map(([name, text]) => [resolve('/virtual', name), text]));
    return new DocumentStore(async (path) => {
        const text = byPath.get(path);
        if (text === undefined) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return text;
    });
}

const at = (name: string) => resolve('/virtual', name);

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
        await expect(memoryStore({}).loadWithRefs(at('api.yml'))).rejects.toThrow(/cannot read file \(ENOENT\)/);
    });

    test('resolves local refs and names the target', async () => {
        const store = memoryStore({ 'api.yml': 'components: {schemas: {Pet: {type: object}}}' });
        await store.loadWithRefs(at('api.yml'));
        const resolved = store.deref({ $ref: '#/components/schemas/Pet' }, at('api.yml'));
        expect(resolved).toEqual({
            value: { type: 'object' },
            file: at('api.yml'),
            key: `${at('api.yml')}#/components/schemas/Pet`,
            name: 'Pet',
        });
    });

    test('a node that is not a reference resolves to itself', async () => {
        const store = memoryStore({});
        expect(store.deref({ type: 'string' }, at('api.yml'))).toEqual({ value: { type: 'string' }, file: at('api.yml') });
    });

    test('loads referenced files transitively and resolves relative to the referring file', async () => {
        const store = memoryStore({
            'api.yml': 'schema: {$ref: "schemas/pet.yml#/Pet"}',
            'schemas/pet.yml': 'Pet: {properties: {owner: {$ref: "../common/owner.yml"}}}',
            'common/owner.yml': 'type: object',
        });
        await store.loadWithRefs(at('api.yml'));

        const pet = store.deref({ $ref: 'schemas/pet.yml#/Pet' }, at('api.yml'));
        expect(pet.file).toBe(at('schemas/pet.yml'));
        expect(pet.name).toBe('Pet');

        const ownerRef = (pet.value as { properties: { owner: unknown } }).properties.owner;
        const owner = store.deref(ownerRef, pet.file);
        expect(owner.value).toEqual({ type: 'object' });
        expect(owner.name).toBe('owner');
    });

    test('a ref into a missing file is unresolved, with the reason', async () => {
        const store = memoryStore({ 'api.yml': 'schema: {$ref: "missing.yml#/X"}' });
        await store.loadWithRefs(at('api.yml'));
        expect(store.deref({ $ref: 'missing.yml#/X' }, at('api.yml'))).toEqual({
            value: undefined,
            file: at('api.yml'),
            unresolved: 'missing.yml#/X',
            reason: `${at('missing.yml')}: cannot read file (ENOENT)`,
        });
    });

    test('follows chains of refs and keeps the first name', async () => {
        const store = memoryStore({ 'api.yml': 'a: {$ref: "#/b"}\nb: {$ref: "#/c"}\nc: {type: string}' });
        await store.loadWithRefs(at('api.yml'));
        const resolved = store.deref({ $ref: '#/a' }, at('api.yml'));
        expect(resolved.value).toEqual({ type: 'string' });
        expect(resolved.name).toBe('a');
        expect(resolved.key).toBe(`${at('api.yml')}#/c`);
    });

    test('a cycle of pure refs is unresolved instead of looping', async () => {
        const store = memoryStore({ 'api.yml': 'a: {$ref: "#/b"}\nb: {$ref: "#/a"}' });
        await store.loadWithRefs(at('api.yml'));
        expect(store.deref({ $ref: '#/a' }, at('api.yml')).unresolved).toBe('#/a');
    });

    test('remote and anchor refs are unresolved', async () => {
        const store = memoryStore({ 'api.yml': 'a: {$ref: "https://example.com/pet.yml"}\nPet: {type: object}' });
        await store.loadWithRefs(at('api.yml'));
        expect(store.deref({ $ref: 'https://example.com/pet.yml' }, at('api.yml')).unresolved).toBe('https://example.com/pet.yml');
        expect(store.deref({ $ref: '#Pet' }, at('api.yml')).unresolved).toBe('#Pet');
    });

    test('decodes escaped pointer tokens', async () => {
        const store = memoryStore({ 'api.yml': 'paths: {"/pets/{id}": {x: 1}}' });
        await store.loadWithRefs(at('api.yml'));
        expect(store.deref({ $ref: '#/paths/~1pets~1%7Bid%7D' }, at('api.yml')).value).toEqual({ x: 1 });
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
