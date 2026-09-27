import { expect, test } from 'vitest';
import { detectVersion } from './version.ts';

test.each([
    ['3.0.3', '3.0'],
    ['3.1.0', '3.1+'],
    ['3.2.0', '3.1+'],
    ['3.3.0', '3.1+'],
])('openapi %s is family %s', (raw, family) => {
    expect(detectVersion({ openapi: raw }, 'api.yml')).toEqual({ raw, family });
});

test('an unquoted YAML number still counts', () => {
    expect(detectVersion({ openapi: 3.1 }, 'api.yml')).toEqual({ raw: '3.1', family: '3.1+' });
    // `openapi: 3.0` parses as the number 3.
    expect(detectVersion({ openapi: 3 }, 'api.yml')).toEqual({ raw: '3.0', family: '3.0' });
});

test('a document without openapi is not an OpenAPI document', () => {
    expect(detectVersion({ components: {} }, 'api.yml')).toBeUndefined();
    expect(detectVersion('text', 'api.yml')).toBeUndefined();
});

test('Swagger 2.0 and unknown versions are input errors', () => {
    expect(() => detectVersion({ swagger: '2.0' }, 'api.yml')).toThrow('api.yml: Swagger 2.0 documents are not supported');
    expect(() => detectVersion({ openapi: '4.0.0' }, 'api.yml')).toThrow('api.yml: unsupported OpenAPI version "4.0.0"');
});
