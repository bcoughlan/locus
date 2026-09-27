import { expect, test } from 'vitest';
import { getByParts, partsToPointer, pointerToParts } from './json-pointer.ts';

test('pointerToParts unescapes ~1 and ~0 and URI escapes', () => {
    expect(pointerToParts('#/paths/~1pets~1{id}/get')).toEqual(['paths', '/pets/{id}', 'get']);
    expect(pointerToParts('#/a~0b')).toEqual(['a~b']);
    expect(pointerToParts('#/a%20b')).toEqual(['a b']);
    expect(pointerToParts('/x')).toEqual(['x']);
    expect(pointerToParts('#')).toEqual([]);
    expect(pointerToParts('')).toEqual([]);
});

test('partsToPointer escapes and round-trips', () => {
    expect(partsToPointer(['paths', '/pets/{id}'])).toBe('#/paths/~1pets~1{id}');
    expect(pointerToParts(partsToPointer(['a~/b']))).toEqual(['a~/b']);
});

test('getByParts returns undefined for missing steps and inherited properties', () => {
    const doc = { a: { b: [10, 20] } };
    expect(getByParts(doc, ['a', 'b', '1'])).toBe(20);
    expect(getByParts(doc, ['a', 'c'])).toBeUndefined();
    expect(getByParts(doc, ['a', 'toString'])).toBeUndefined();
    expect(getByParts(doc, [])).toBe(doc);
});
