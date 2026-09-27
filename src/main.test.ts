import { expect, test } from 'vitest';
import { detectColor } from './main.ts';

test('the detected color level applies', () => {
    expect(detectColor({}, { level: 1 })).toBe(1);
    expect(detectColor({}, { level: 3 })).toBe(3);
});

test('no colors when the terminal has none', () => {
    expect(detectColor({}, false)).toBe(0);
});

test('NO_COLOR turns colors off, but an empty NO_COLOR does not', () => {
    expect(detectColor({ NO_COLOR: '1' }, { level: 3 })).toBe(0);
    expect(detectColor({ NO_COLOR: '' }, { level: 3 })).toBe(3);
});
