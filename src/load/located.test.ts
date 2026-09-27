import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Located, pointerToParts } from './located.ts';

test('pointerToParts unescapes ~1 and ~0 and URI escapes', () => {
    expect(pointerToParts('#/paths/~1pets~1{id}/get')).toEqual(['paths', '/pets/{id}', 'get']);
    expect(pointerToParts('#/a~0b')).toEqual(['a~b']);
    expect(pointerToParts('#/a%20b')).toEqual(['a b']);
    expect(pointerToParts('/x')).toEqual(['x']);
    expect(pointerToParts('#')).toEqual([]);
    expect(pointerToParts('')).toEqual([]);
});

describe('Located', () => {
    const file = resolve('/virtual/api.yml');
    const root = Located.root({ paths: { '/pets/{id}': { get: { parameters: [{ name: 'id' }] } } }, 'a~b': 1 }, file);

    test('steps to children and builds an escaped pointer that round-trips', () => {
        const op = root.at('paths', '/pets/{id}', 'get');
        expect(op.value).toEqual({ parameters: [{ name: 'id' }] });
        expect(op.pointer).toBe('#/paths/~1pets~1{id}/get');
        expect(op.at('parameters', 0, 'name').pointer).toBe('#/paths/~1pets~1{id}/get/parameters/0/name');
        expect(pointerToParts(root.at('a~b').pointer)).toEqual(['a~b']);
        expect(root.pointer).toBe('#');
        expect(op.source).toEqual({ file, pointer: '#/paths/~1pets~1{id}/get' });
        expect(op.id).toBe(`${file}#/paths/~1pets~1{id}/get`);
    });

    test('a missing step or an inherited property gives undefined', () => {
        expect(root.at('paths', 'missing', 'get').value).toBeUndefined();
        expect(root.at('toString').value).toBeUndefined();
        expect(root.at('a~b', 'x').value).toBeUndefined();
    });

    test('entries lists object members and items lists array members', () => {
        expect(root.at('paths').entries().map(([key, loc]) => [key, loc.pointer])).toEqual([['/pets/{id}', '#/paths/~1pets~1{id}']]);
        expect(root.at('paths', '/pets/{id}', 'get', 'parameters').items().map((loc) => loc.value)).toEqual([{ name: 'id' }]);
        expect(root.at('paths', '/pets/{id}', 'get', 'parameters').entries()).toEqual([]);
        expect(root.at('paths').items()).toEqual([]);
    });

    test('the name is the last key, or the file name for a whole file', () => {
        expect(root.at('paths', '/pets/{id}').name).toBe('/pets/{id}');
        expect(root.name).toBe('api');
    });

    test('with keeps the place and changes the value', () => {
        const other = root.at('paths').with({ x: 1 });
        expect(other.value).toEqual({ x: 1 });
        expect(other.pointer).toBe('#/paths');
        expect(other.at('x').pointer).toBe('#/paths/x');
    });
});
