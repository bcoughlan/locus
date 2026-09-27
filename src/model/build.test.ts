import { describe, expect, test } from 'vitest';
import { buildYaml as build, childKeys as keys, find, spec } from '../testing/build-yaml.ts';
import type { ViewNode } from './tree.ts';

describe('document and operations', () => {
    test('the document node holds title, version, OpenAPI version, and servers', async () => {
        const doc = await build(spec('  {}', 'servers: [{url: "https://api.example.com"}]'));
        expect(doc.info).toMatchObject({
            kind: 'document',
            label: 'Test',
            attrs: { title: 'Test', version: '1', openapi: '3.1.0', servers: ['https://api.example.com'] },
        });
    });

    test('operations in document order, with 3.2 query and additionalOperations', async () => {
        const doc = await build(
            spec(`
  /pets:
    post: {responses: {}}
    get: {operationId: listPets, summary: List, tags: [pets], deprecated: true, responses: {}}
    query: {responses: {}}
    additionalOperations:
      COPY: {responses: {}}`),
        );
        expect(doc.operations.map((op) => op.key)).toEqual(['GET /pets', 'POST /pets', 'QUERY /pets', 'COPY /pets']);
        expect(doc.operations[0].attrs).toEqual({
            method: 'GET',
            path: '/pets',
            operationId: 'listPets',
            summary: 'List',
            tags: ['pets'],
            deprecated: true,
        });
    });

    test('summary, description, and servers fall back to the path item', async () => {
        const doc = await build(spec(`
  /pets:
    summary: Pets
    description: All pets
    servers: [{url: "https://pets.example.com"}]
    get: {responses: {}}`));
        expect(doc.operations[0].attrs).toMatchObject({ summary: 'Pets', description: 'All pets', servers: ['https://pets.example.com'] });
    });

    test('a path item $ref resolves', async () => {
        const doc = await build(
            spec('  /pets: {$ref: "#/components/pathItems/Pets"}', 'components:\n  pathItems:\n    Pets: {get: {operationId: listPets, responses: {}}}'),
        );
        expect(doc.operations[0].attrs.operationId).toBe('listPets');
    });

    test('specification extensions under paths are not operations', async () => {
        const doc = await build(spec('  x-internal: {get: {responses: {}}}\n  /pets: {get: {responses: {}}}'));
        expect(doc.operations.map((op) => op.key)).toEqual(['GET /pets']);
    });

    test('a description next to a response $ref overrides the target (3.1)', async () => {
        const doc = await build(
            spec(
                `  /pets/{id}:\n    get:\n      responses:\n        '404': {$ref: "#/components/responses/NotFound", description: Pet not found}`,
                'components:\n  responses:\n    NotFound: {description: Not found}',
            ),
        );
        expect(find(doc.operations[0], 'responses', '404').attrs).toEqual({ description: 'Pet not found' });
    });

    test('webhooks flip the directions', async () => {
        const doc = await build(`openapi: 3.1.0
info: {title: T, version: '1'}
webhooks:
  newPet:
    post:
      requestBody: {content: {application/json: {schema: {type: object}}}}
      responses: {'200': {description: ok}}`);
        const hook = doc.webhooks[0];
        expect(hook.key).toBe('POST newPet');
        expect(find(hook, 'request').direction).toBe('response');
        expect(find(hook, 'responses').direction).toBe('request');
    });
});

describe('parameters', () => {
    test('grouped by location in a fixed order, operation parameters override path item parameters', async () => {
        const doc = await build(spec(`
  /pets/{petId}:
    parameters:
      - {name: petId, in: path, required: true, schema: {type: string}}
      - {name: limit, in: query, description: path-level}
    get:
      parameters:
        - {name: X-Trace, in: header, schema: {type: string}}
        - {name: limit, in: query, description: operation-level, schema: {type: integer, maximum: 100}}
        - {name: session, in: cookie, schema: {type: string}}
      responses: {}`));
        const request = find(doc.operations[0], 'request');
        expect(keys(request)).toEqual(['path', 'query', 'header', 'cookie']);
        expect(find(request, 'query', 'limit').attrs).toEqual({ description: 'operation-level', type: ['integer'], maximum: 100 });
        expect(find(request, 'header', 'x-trace').label).toBe('X-Trace');
    });

    test('path parameters match by position and are always required', async () => {
        const doc = await build(spec(`
  /owners/{ownerId}/pets/{petId}:
    get:
      parameters:
        - {name: petId, in: path, schema: {type: string}}
        - {name: ownerId, in: path, schema: {type: string}}
      responses: {}`));
        const path = find(doc.operations[0], 'request', 'path');
        expect(path.children.map((p) => [p.key, p.label, p.attrs.required])).toEqual([
            ['#1', 'petId', true],
            ['#0', 'ownerId', true],
        ]);
    });

    test('Accept, Content-Type, and Authorization header parameters are ignored', async () => {
        const doc = await build(spec(`
  /pets:
    get:
      parameters:
        - {name: Accept, in: header}
        - {name: authorization, in: header}
      responses: {}`));
        expect(doc.operations[0].children).toEqual([]);
    });

    test('style and explode appear only when they differ from the default', async () => {
        const doc = await build(spec(`
  /pets:
    get:
      parameters:
        - {name: a, in: query, style: form, explode: true}
        - {name: b, in: query, explode: false}
        - {name: c, in: query, style: deepObject}
        - {name: d, in: header, style: simple}
      responses: {}`));
        const query = find(doc.operations[0], 'request', 'query');
        // deepObject does not explode by default: only form does.
        expect(query.children.map((p) => p.attrs)).toEqual([{}, { explode: false }, { style: 'deepObject' }]);
        expect(find(doc.operations[0], 'request', 'header', 'd').attrs).toEqual({});
    });

    test('a parameter with content takes the schema of its media type; 3.2 querystring is its own group', async () => {
        const doc = await build(spec(`
  /search:
    get:
      parameters:
        - name: filter
          in: querystring
          content: {application/x-www-form-urlencoded: {schema: {type: object, properties: {q: {type: string}}}}}
      responses: {}`));
        const filter = find(doc.operations[0], 'request', 'querystring', 'filter');
        expect(filter.attrs).toEqual({ contentType: 'application/x-www-form-urlencoded', type: ['object'] });
        expect(keys(filter)).toEqual(['q']);
    });

    test('a parameter $ref resolves, and the examples show by name', async () => {
        const doc = await build(
            spec(
                '  /pets:\n    get: {parameters: [{$ref: "#/components/parameters/Limit"}], responses: {}}',
                `components:
  parameters:
    Limit: {name: limit, in: query, schema: {type: integer, default: 20}, examples: {small: {value: 5}, ref: {$ref: "#/components/examples/Big"}}}
  examples:
    Big: {value: 500}`,
            ),
        );
        expect(find(doc.operations[0], 'request', 'query', 'limit').attrs).toEqual({
            examples: { small: 5, ref: 500 },
            type: ['integer'],
            default: 20,
        });
    });
});

describe('request bodies and responses', () => {
    test('a request body with media types; readOnly properties leave the request', async () => {
        const doc = await build(
            spec(
                '  /pets:\n    post: {requestBody: {$ref: "#/components/requestBodies/Pet"}, responses: {}}',
                `components:
  requestBodies:
    Pet:
      required: true
      description: The pet
      content:
        application/json: {schema: {$ref: "#/components/schemas/Pet"}}
        application/xml: {}
  schemas:
    Pet:
      type: object
      required: [id, name]
      properties:
        id: {type: integer, readOnly: true}
        name: {type: string}`,
            ),
        );
        const body = find(doc.operations[0], 'request', 'body');
        expect(body.attrs).toEqual({ required: true, description: 'The pet' });
        expect(keys(body)).toEqual(['application/json', 'application/xml']);
        const json = find(body, 'application/json');
        expect(json.attrs).toEqual({ title: 'Pet', type: ['object'] });
        expect(json.children.map((p) => [p.key, p.attrs])).toEqual([['name', { required: true, type: ['string'] }]]);
    });

    test('responses sort by status code; headers group; writeOnly properties leave the response', async () => {
        const doc = await build(spec(`
  /pets:
    get:
      responses:
        default: {description: Error}
        '404': {description: Not found}
        2XX: {description: Other success}
        '200':
          description: OK
          headers:
            X-Rate-Limit: {schema: {type: integer}, required: true}
            Content-Type: {schema: {type: string}}
          content:
            application/json:
              schema:
                properties:
                  name: {type: string}
                  password: {type: string, writeOnly: true}`));
        const responses = find(doc.operations[0], 'responses');
        expect(keys(responses)).toEqual(['200', '2XX', '404', 'DEFAULT']);
        const ok = find(responses, '200');
        expect(ok.attrs).toEqual({ description: 'OK' });
        expect(keys(find(ok, 'headers'))).toEqual(['x-rate-limit']);
        expect(find(ok, 'headers', 'x-rate-limit').attrs).toEqual({ required: true, type: ['integer'] });
        expect(keys(find(ok, 'application/json'))).toEqual(['name']);
    });

    test('3.2 response summary and itemSchema', async () => {
        const doc = await build(spec(`
  /events:
    get:
      responses:
        '200':
          summary: Event stream
          content:
            application/jsonl:
              itemSchema: {type: object, properties: {id: {type: string}}}`, '', '3.2.0'));
        const ok = find(doc.operations[0], 'responses', '200');
        expect(ok.attrs).toEqual({ summary: 'Event stream' });
        expect(find(ok, 'application/jsonl', 'itemSchema').children.map((c) => c.key)).toEqual(['id']);
    });
});

describe('schemas', () => {
    /** The schema of the 200 application/json response of GET /x. */
    async function schemaOf(schema: string, components = '', version = '3.1.0'): Promise<ViewNode> {
        const doc = await build(
            spec(`  /x:\n    get:\n      responses:\n        '200':\n          content:\n            application/json:\n              schema: ${schema}`, components, version),
        );
        return find(doc.operations[0], 'responses', '200', 'application/json');
    }

    test('constraints, enum, format, default, and example', async () => {
        const node = await schemaOf(
            '{type: string, format: email, minLength: 3, maxLength: 9, pattern: "^a", enum: [a1, a2], default: a1, examples: [a2], description: Mail}',
        );
        expect(node.attrs).toEqual({
            type: ['string'],
            format: 'email',
            description: 'Mail',
            enum: ['a1', 'a2'],
            default: 'a1',
            example: 'a2',
            minLength: 3,
            maxLength: 9,
            pattern: '^a',
        });
    });

    test('allOf members merge: properties, required, the tightest limits, and the outer name', async () => {
        const node = await schemaOf(
            '{$ref: "#/components/schemas/Dog"}',
            `components:
  schemas:
    Pet: {type: object, required: [name], properties: {name: {type: string, maxLength: 50}}}
    Dog:
      allOf:
        - $ref: "#/components/schemas/Pet"
        - {properties: {bark: {type: boolean}, name: {maxLength: 20}}, required: [bark]}`,
        );
        expect(node.attrs).toEqual({ title: 'Dog', type: ['object'] });
        expect(node.children.map((p) => [p.key, p.attrs])).toEqual([
            ['name', { required: true, type: ['string'], maxLength: 20 }],
            ['bark', { required: true, type: ['boolean'] }],
        ]);
    });

    test('a recursive schema stops with a marker', async () => {
        const node = await schemaOf(
            '{$ref: "#/components/schemas/Node"}',
            'components:\n  schemas:\n    Node: {type: object, properties: {children: {type: array, items: {$ref: "#/components/schemas/Node"}}}}',
        );
        const items = find(node, 'children', '[]');
        expect(items.attrs).toEqual({ recursive: 'Node' });
        expect(items.children).toEqual([]);
    });

    test('oneOf variants are keyed by name, then by type, then by position', async () => {
        const node = await schemaOf(
            '{oneOf: [{$ref: "#/components/schemas/Cat"}, {type: string}, {type: object}, {type: object}], discriminator: {propertyName: kind, mapping: {cat: "#/components/schemas/Cat"}}}',
            'components:\n  schemas:\n    Cat: {type: object}',
        );
        expect(node.attrs).toEqual({ composition: 'oneOf', discriminator: 'kind', mapping: { cat: 'Cat' } });
        expect(keys(node)).toEqual(['Cat', 'string', '#3', '#4']);
    });

    test('3.0 nullable and 3.1 "null" type give the same node', async () => {
        const v30 = await schemaOf('{type: string, nullable: true}', '', '3.0.3');
        const v31 = await schemaOf('{type: [string, "null"]}');
        const anyOf = await schemaOf('{anyOf: [{type: string}, {type: "null"}]}');
        expect(v30.attrs).toEqual({ type: ['string', 'null'] });
        expect(v31.attrs).toEqual(v30.attrs);
        expect(anyOf.attrs).toEqual(v30.attrs);
    });

    test('3.0 nullable next to allOf keeps the name and adds null', async () => {
        const node = await schemaOf(
            '{nullable: true, allOf: [{$ref: "#/components/schemas/Pet"}]}',
            'components:\n  schemas:\n    Pet: {type: object, properties: {name: {type: string}}}',
            '3.0.3',
        );
        expect(node.attrs).toEqual({ title: 'Pet', type: ['object', 'null'] });
        expect(keys(node)).toEqual(['name']);
    });

    test('3.0 boolean exclusiveMaximum becomes the 3.1 number form', async () => {
        const node = await schemaOf('{type: integer, maximum: 10, exclusiveMaximum: true}', '', '3.0.3');
        expect(node.attrs).toEqual({ type: ['integer'], exclusiveMaximum: 10 });
    });

    test('arrays, additional properties, pattern properties, and prefix items', async () => {
        const node = await schemaOf(
            '{type: object, additionalProperties: {type: integer}, patternProperties: {"^x-": {type: string}}, properties: {tuple: {type: array, prefixItems: [{type: string}], items: {type: number}}, closed: {type: object, additionalProperties: false}}}',
        );
        expect(keys(node)).toEqual(['tuple', 'closed', '/^x-/', '*']);
        expect(keys(find(node, 'tuple'))).toEqual(['[0]', '[]']);
        expect(find(node, 'closed').attrs).toEqual({ type: ['object'], additionalProperties: false });
    });

    test('description next to a $ref overrides the target description', async () => {
        const node = await schemaOf(
            '{$ref: "#/components/schemas/Pet", description: Overridden}',
            'components:\n  schemas:\n    Pet: {type: object, description: Original}',
        );
        expect(node.attrs).toEqual({ title: 'Pet', type: ['object'], description: 'Overridden' });
    });

    test('a nullable oneOf without a type gets the nullable fact', async () => {
        const node = await schemaOf('{oneOf: [{type: string}, {type: integer}, {type: "null"}]}');
        expect(node.attrs).toEqual({ nullable: true, composition: 'oneOf' });
        expect(keys(node)).toEqual(['string', 'integer']);
    });

    test('a recursive reference behind a null alternative keeps its marker (3.1 and 3.0)', async () => {
        const v31 = await schemaOf(
            '{$ref: "#/components/schemas/Node"}',
            'components:\n  schemas:\n    Node: {type: object, properties: {parent: {oneOf: [{$ref: "#/components/schemas/Node"}, {type: "null"}]}}}',
        );
        expect(find(v31, 'parent').attrs).toEqual({ recursive: 'Node', nullable: true });
        const v30 = await schemaOf(
            '{$ref: "#/components/schemas/Node"}',
            'components:\n  schemas:\n    Node: {type: object, properties: {parent: {nullable: true, allOf: [{$ref: "#/components/schemas/Node"}]}}}',
            '3.0.3',
        );
        expect(find(v30, 'parent').attrs).toEqual({ recursive: 'Node', nullable: true });
    });

    test('reusing a schema of the parent allOf is not recursion', async () => {
        const node = await schemaOf(
            '{$ref: "#/components/schemas/Error"}',
            `components:
  schemas:
    Problem: {type: object, properties: {title: {type: string}}}
    Error: {allOf: [{$ref: "#/components/schemas/Problem"}], properties: {cause: {$ref: "#/components/schemas/Problem"}}}`,
        );
        expect(keys(node)).toEqual(['title', 'cause']);
        expect(find(node, 'cause').attrs).toEqual({ title: 'Problem', type: ['object'] });
        expect(keys(find(node, 'cause'))).toEqual(['title']);
    });

    test('a second oneOf/anyOf list gives a warning', async () => {
        const doc = await build(
            spec(`  /x:\n    get:\n      responses:\n        '200':\n          content:\n            application/json:\n              schema: {allOf: [{oneOf: [{type: string}, {type: integer}]}, {anyOf: [{type: string}, {type: boolean}]}]}`),
        );
        expect(doc.warnings).toEqual([expect.stringContaining('combines several oneOf/anyOf lists')]);
    });

    test('the boolean schema false becomes a "not" child', async () => {
        const node = await schemaOf('{type: object, properties: {legacy: false}}');
        expect(keys(find(node, 'legacy'))).toEqual(['not']);
    });

    test('unevaluatedProperties: false closes the object', async () => {
        const node = await schemaOf('{allOf: [{properties: {a: {type: string}}}], unevaluatedProperties: false}');
        expect(node.attrs).toEqual({ type: ['object'], additionalProperties: false });
    });

    test('additionalProperties true, {}, and absent are the same', async () => {
        for (const extra of ['true', '{}']) {
            const node = await schemaOf(`{type: object, additionalProperties: ${extra}}`);
            expect(node.attrs).toEqual({ type: ['object'] });
            expect(node.children).toEqual([]);
        }
    });

    test('3.2 discriminator defaultMapping', async () => {
        const node = await schemaOf(
            '{oneOf: [{$ref: "#/components/schemas/Cat"}, {$ref: "#/components/schemas/Dog"}], discriminator: {propertyName: kind, defaultMapping: "#/components/schemas/Cat"}}',
            'components:\n  schemas:\n    Cat: {type: object}\n    Dog: {type: object}',
            '3.2.0',
        );
        expect(node.attrs).toMatchObject({ discriminator: 'kind', defaultMapping: 'Cat' });
    });

    test('schemas in other files resolve relative to their own file', async () => {
        const doc = await build(
            spec(`  /x:\n    get:\n      responses:\n        '200':\n          content:\n            application/json:\n              schema: {$ref: "schemas/pet.yml"}`),
            {
                'schemas/pet.yml': 'type: object\nproperties:\n  owner: {$ref: "owner.yml#/Owner"}',
                'schemas/owner.yml': 'Owner: {type: object, properties: {email: {type: string, format: email}}}',
            },
        );
        const body = find(doc.operations[0], 'responses', '200', 'application/json');
        expect(body.attrs.title).toBe('pet');
        expect(find(body, 'owner', 'email').attrs).toEqual({ type: ['string'], format: 'email' });
        expect(doc.warnings).toEqual([]);
    });

    test('an unresolved $ref becomes a marker and a warning', async () => {
        const doc = await build(
            spec(`  /x:\n    get:\n      responses:\n        '200':\n          content:\n            application/json:\n              schema: {$ref: "missing.yml"}`),
        );
        expect(find(doc.operations[0], 'responses', '200', 'application/json').attrs).toEqual({ unresolved: 'missing.yml' });
        expect(doc.warnings).toEqual([expect.stringContaining('Unresolved $ref "missing.yml"')]);
    });
});

describe('security and callbacks', () => {
    const components = `components:
  securitySchemes:
    apiKey: {type: apiKey, in: header, name: X-API-Key}
    oauth:
      type: oauth2
      flows:
        authorizationCode: {authorizationUrl: "https://a/auth", tokenUrl: "https://a/token", scopes: {read: Read, write: Write}}`;

    test('requirements default to the document security; each is an alternative with its schemes', async () => {
        const doc = await build(spec('  /pets:\n    get: {responses: {}}', `security: [{oauth: [write, read]}, {apiKey: []}, {}]\n${components}`));
        const security = find(doc.operations[0], 'security');
        expect(keys(security)).toEqual(['oauth', 'apiKey', 'none']);
        expect(find(security, 'oauth', 'oauth').attrs).toEqual({
            schemeType: 'oauth2',
            flows: { authorizationCode: { authorizationUrl: 'https://a/auth', tokenUrl: 'https://a/token' } },
            scopes: ['read', 'write'],
        });
        expect(find(security, 'apiKey', 'apiKey').attrs).toEqual({ schemeType: 'apiKey', in: 'header', parameterName: 'X-API-Key' });
    });

    test('an empty operation security removes the document security', async () => {
        const doc = await build(spec('  /pets:\n    get: {security: [], responses: {}}', `security: [{apiKey: []}]\n${components}`));
        expect(keys(doc.operations[0])).toEqual([]);
    });

    test('callbacks hold operations with flipped directions', async () => {
        const doc = await build(spec(`
  /subscribe:
    post:
      callbacks:
        onEvent:
          '{$request.body#/url}':
            post:
              requestBody: {content: {application/json: {schema: {type: object}}}}
              responses: {'200': {description: ok}}
      responses: {}`));
        const callback = find(doc.operations[0], 'callbacks', 'onEvent');
        expect(keys(callback)).toEqual(['POST {$request.body#/url}']);
        const op = callback.children[0];
        expect(find(op, 'request').direction).toBe('response');
        expect(find(op, 'responses').direction).toBe('request');
    });
});
