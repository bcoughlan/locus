import { describe, expect, test } from 'vitest';
import { diffDocument } from '../diff/diff.ts';
import type { DocumentDiff } from '../diff/report.ts';
import { buildYaml, spec } from '../testing/build-yaml.ts';
import { digestText, documentView } from './docs.ts';

async function diff(base: string, head: string): Promise<DocumentDiff> {
    return diffDocument('api.yml', { display: 'old/api.yml', model: await buildYaml(base) }, { display: 'api.yml', model: await buildYaml(head) });
}

/** The digest of the first endpoint, one line per entry. */
async function digestOf(base: string, head: string): Promise<string[]> {
    const [op] = documentView(await diff(base, head), true).operations;
    return op.digest.map(digestText);
}

const pets = (schema: string, parameters = '') =>
    spec(
        `  /pets:\n    get:\n      parameters: [${parameters}]\n      responses: {'200': {description: OK, content: {application/json: {schema: {$ref: '#/components/schemas/Pet'}}}}}`,
        `components:\n  schemas:\n    Pet: ${schema}\n    Owner: {type: object, properties: {name: {type: string}}}`,
    );

describe('digest', () => {
    test('names the place of each change, with schema steps joined by dots', async () => {
        const base = pets("{type: object, properties: {owner: {$ref: '#/components/schemas/Owner'}, tags: {type: array, items: {type: string}}}}");
        const head = pets(
            "{type: object, properties: {owner: {$ref: '#/components/schemas/Owner'}, tags: {type: array, items: {type: string, maxLength: 5}}}}",
            '{name: limit, in: query, required: true, schema: {type: integer}}',
        ).replace('Owner: {type: object, properties: {name: {type: string}}}', 'Owner: {type: object, properties: {name: {type: string}, age: {type: integer}}}');
        expect(await digestOf(base, head)).toEqual([
            'query parameter limit: added  [breaking: required query parameter added (client sends)]',
            'response 200 › application/json › owner.age: added',
            'response 200 › application/json › tags[]: maxLength: (none) → 5',
        ]);
    });

    test('an added section lists its children, with the reason of the section', async () => {
        const base = pets('{type: object}');
        const head = pets('{type: object}', '{name: a, in: query, schema: {type: string}}, {name: b, in: query, schema: {type: string}}');
        expect(await digestOf(base, head)).toEqual(['query parameter a: added', 'query parameter b: added']);
    });

    test('a definition used twice counts once', async () => {
        const twice = (extra: string) =>
            pets(`{type: object, properties: {owner: {$ref: '#/components/schemas/Owner'}, seller: {$ref: '#/components/schemas/Owner'}}}`).replace(
                "name: {type: string}}}",
                `name: {type: string}${extra}}}`,
            );
        expect(await digestOf(twice(''), twice(', age: {type: integer}'))).toEqual(['response 200 › application/json › owner.age: added']);
    });

    test('an unchanged endpoint has no digest', async () => {
        expect(await digestOf(pets('{type: object}'), pets('{type: object}'))).toEqual([]);
    });
});
