import { describe, expect, test } from 'vitest';
import type { ViewNode } from '../model/tree.ts';
import { buildYaml, childKeys, find, spec } from '../testing/build-yaml.ts';
import { buildReport, diffDocument, matchOperations } from './diff.ts';
import type { DiffNode, DocumentDiff } from './report.ts';

async function diff(base: string, head: string): Promise<DocumentDiff> {
    return diffDocument('api.yml', { display: 'old/api.yml', model: await buildYaml(base) }, { display: 'api.yml', model: await buildYaml(head) });
}

function op(method: string, path: string, operationId?: string): ViewNode {
    return { kind: 'operation', key: `${method} ${path}`, label: `${method} ${path}`, direction: 'request', attrs: { method, path, operationId }, children: [] };
}

const keysOf = (pairs: [ViewNode | undefined, ViewNode | undefined][]) => pairs.map(([b, h]) => [b?.key, h?.key]);

describe('matchOperations', () => {
    test('matches by operationId first, so a moved endpoint stays one endpoint', () => {
        const pairs = matchOperations([op('GET', '/pets', 'listPets')], [op('GET', '/animals', 'listPets')]);
        expect(keysOf(pairs)).toEqual([['GET /pets', 'GET /animals']]);
    });

    test('falls back to method and path, then to path with parameter names ignored', () => {
        const pairs = matchOperations([op('GET', '/pets', 'a'), op('GET', '/pets/{id}')], [op('GET', '/pets', 'b'), op('GET', '/pets/{petId}')]);
        expect(keysOf(pairs)).toEqual([
            ['GET /pets', 'GET /pets'],
            ['GET /pets/{id}', 'GET /pets/{petId}'],
        ]);
    });

    test('an operationId that repeats on one side does not match by id', () => {
        const pairs = matchOperations([op('GET', '/a', 'dup'), op('GET', '/b', 'dup')], [op('GET', '/b', 'dup')]);
        expect(keysOf(pairs)).toEqual([
            ['GET /a', undefined],
            ['GET /b', 'GET /b'],
        ]);
    });

    test('removed operations keep their base position, before additions in the same gap', () => {
        const pairs = matchOperations([op('GET', '/a'), op('GET', '/b'), op('GET', '/c')], [op('GET', '/a'), op('GET', '/new'), op('GET', '/c')]);
        expect(keysOf(pairs)).toEqual([
            ['GET /a', 'GET /a'],
            ['GET /b', undefined],
            [undefined, 'GET /new'],
            ['GET /c', 'GET /c'],
        ]);
    });
});

describe('diffDocument', () => {
    const pets = (extra = '', props = 'name: {type: string}') =>
        spec(`
  /pets:
    get:
      operationId: listPets
      parameters:
        - {name: limit, in: query, schema: {type: integer, maximum: 500}}${extra}
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                properties:
                  ${props}`);

    test('identical documents have no changes', async () => {
        const result = await diff(pets(), pets());
        expect(result.status).toBe('unchanged');
        expect(result.impact).toBeUndefined();
        expect(result.operations[0]).toMatchObject({ status: 'unchanged', impact: undefined });
    });

    test('a changed attribute gets a verdict and the impact rolls up to the endpoint', async () => {
        const result = await diff(pets(), pets().replace('maximum: 500', 'maximum: 100'));
        const endpoint = result.operations[0];
        const limit = find(endpoint, 'request', 'query', 'limit');
        expect(limit.status).toBe('changed');
        expect(limit.changes).toEqual([
            { name: 'maximum', before: 500, after: 100, severity: 'breaking', reason: 'maximum decreased (client sends)' },
        ]);
        expect(find(endpoint, 'request').impact).toBe('breaking');
        expect(endpoint).toMatchObject({ status: 'unchanged', impact: 'breaking' });
        expect(result).toMatchObject({ status: 'changed', impact: 'breaking' });
    });

    test('an added subtree is classified at its root; descendants inherit the severity only', async () => {
        const result = await diff(pets(), pets('', 'name: {type: string}\n                  owner: {type: object, properties: {email: {type: string}}}'));
        const owner = find(result.operations[0], 'responses', '200', 'application/json', 'owner');
        expect(owner).toMatchObject({ status: 'added', verdict: { severity: 'compatible', reason: 'optional property added (client receives)' } });
        expect(find(owner, 'email')).toMatchObject({ status: 'added', verdict: { severity: 'compatible' }, impact: 'compatible' });
        expect(find(owner, 'email').verdict?.reason).toBeUndefined();
    });

    test('a new parameter group classifies each parameter on its own', async () => {
        const result = await diff(
            pets(),
            pets('\n        - {name: X-Req, in: header, required: true, schema: {type: string}}\n        - {name: X-Opt, in: header, schema: {type: string}}'),
        );
        const headers = find(result.operations[0], 'request', 'header');
        expect(headers.status).toBe('added');
        expect(headers.children.map((p: DiffNode) => [p.label, p.verdict])).toEqual([
            ['X-Req', { severity: 'breaking', reason: 'required header parameter added (client sends)' }],
            ['X-Opt', { severity: 'compatible', reason: 'optional header parameter added (client sends)' }],
        ]);
        expect(headers.impact).toBe('breaking');
    });

    test('a removed node shows its base facts in its base position', async () => {
        const base = pets('', 'id: {type: integer}\n                  name: {type: string}\n                  tag: {type: string}');
        const head = pets('', 'id: {type: integer}\n                  tag: {type: string}');
        const body = find((await diff(base, head)).operations[0], 'responses', '200', 'application/json');
        expect(childKeys(body)).toEqual(['id', 'name', 'tag']);
        expect(find(body, 'name')).toMatchObject({ status: 'removed', attrs: { type: ['string'] }, verdict: { severity: 'breaking', reason: 'property removed' } });
    });

    test('a renamed path parameter is a compatible name change', async () => {
        const base = spec('  /pets/{id}:\n    get: {parameters: [{name: id, in: path, required: true}], responses: {}}');
        const head = spec('  /pets/{petId}:\n    get: {parameters: [{name: petId, in: path, required: true}], responses: {}}');
        const endpoint = (await diff(base, head)).operations[0];
        expect(endpoint.changes).toEqual([
            { name: 'path', before: '/pets/{id}', after: '/pets/{petId}', severity: 'compatible', reason: 'path parameter renamed' },
        ]);
        expect(find(endpoint, 'request', 'path', '#0').changes).toEqual([
            { name: 'name', before: 'id', after: 'petId', severity: 'compatible', reason: 'renamed' },
        ]);
    });

    test('a file on one side only has all its endpoints added or removed', async () => {
        const model = await buildYaml(pets());
        const added = diffDocument('api.yml', undefined, { display: 'api.yml', model });
        const removed = diffDocument('api.yml', { display: 'api.yml', model }, undefined);
        expect(added).toMatchObject({ status: 'added', impact: 'compatible', operations: [{ status: 'added' }] });
        expect(removed).toMatchObject({ status: 'removed', impact: 'breaking', operations: [{ status: 'removed', verdict: { reason: 'endpoint removed' } }] });
    });

    test('every change inside "not" is breaking, because "not" reverses the direction rules', async () => {
        const result = await diff(pets('', 'kind: {not: {enum: [a]}}'), pets('', 'kind: {not: {enum: [a, b]}}'));
        const not = find(result.operations[0], 'responses', '200', 'application/json', 'kind', 'not');
        expect(not.changes).toEqual([expect.objectContaining({ name: 'enum', severity: 'breaking', reason: 'enum value added: b (client receives), inside "not"' })]);
        expect(result.impact).toBe('breaking');
    });

    test('an operation that starts to override the document servers compares with the document servers', async () => {
        const base = spec('  /pets: {get: {responses: {}}}', 'servers: [{url: "https://api"}]');
        const head = spec('  /pets: {get: {servers: [{url: "https://new"}], responses: {}}}', 'servers: [{url: "https://api"}]');
        const endpoint = (await diff(base, head)).operations[0];
        expect(endpoint.changes).toEqual([
            { name: 'servers', before: ['https://api'], after: ['https://new'], severity: 'breaking', reason: 'server removed: https://api' },
        ]);
    });

    test('a property named like a synthetic child does not match that child', async () => {
        const doc = (schema: string) =>
            spec(`  /pets:\n    get:\n      responses:\n        '200':\n          content:\n            application/json:\n              schema: ${schema}`);
        const result = await diff(doc('{type: object, properties: {not: {type: string}}}'), doc('{type: object, not: {type: string}}'));
        const body = find(result.operations[0], 'responses', '200', 'application/json');
        expect(body.children.map((child) => [child.kind, child.key, child.status])).toEqual([
            ['property', 'not', 'removed'],
            ['not', 'not', 'added'],
        ]);
    });

    test('renamed oneOf members pair by position', async () => {
        const schemas = (name: string) =>
            `components:\n  schemas:\n    ${name}: {type: object, properties: {meow: {type: boolean}}}\n    Dog: {type: object}`;
        const doc = (name: string) =>
            spec(
                `  /pets:\n    get:\n      responses:\n        '200':\n          content:\n            application/json:\n              schema: {oneOf: [{$ref: "#/components/schemas/${name}"}, {$ref: "#/components/schemas/Dog"}]}`,
                schemas(name),
            );
        const result = await diff(doc('Cat'), doc('Feline'));
        const body = find(result.operations[0], 'responses', '200', 'application/json');
        expect(body.children.map((child) => child.key)).toEqual(['Feline', 'Dog']);
        // The rename shows in the shared definition diff that the variant refers to.
        const feline = result.schemas[body.children[0].ref!];
        expect(feline.changes).toEqual([expect.objectContaining({ name: 'title', before: 'Cat', after: 'Feline', severity: 'compatible' })]);
        expect(result.schemas[body.children[1].ref!].status).toBe('unchanged');
    });

    test('enum order does not count as a change', async () => {
        const result = await diff(pets('', 'kind: {enum: [a, b]}'), pets('', 'kind: {enum: [b, a]}'));
        expect(result.status).toBe('unchanged');
    });
});

describe('buildReport', () => {
    test('counts endpoints by outcome and flags breaking changes', async () => {
        const base = spec(`
  /a: {get: {responses: {}}}
  /b: {get: {responses: {}}}
  /c: {get: {parameters: [{name: q, in: query}], responses: {}}}
  /d: {get: {description: old, responses: {}}}`);
        const head = spec(`
  /a: {get: {responses: {}}}
  /c: {get: {parameters: [{name: q, in: query, required: true}], responses: {}}}
  /d: {get: {description: new, responses: {}}}
  /e: {get: {responses: {}}}`);
        const report = buildReport([await diff(base, head)], 'old', 'new');
        expect(report.endpoints).toEqual({ added: 1, removed: 1, breaking: 1, compatible: 1, unchanged: 1 });
        expect(report.breaking).toBe(true);
    });
});
