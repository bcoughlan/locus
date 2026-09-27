import { describe, expect, test } from 'vitest';
import type { Attrs, Direction, NodeKind, ViewNode } from '../model/tree.ts';
import { classifyAdded, classifyAttr, classifyRemoved, normalizePath } from './rules.ts';

function node(kind: NodeKind, direction: Direction = 'request', attrs: Attrs = {}, key = 'k', children: ViewNode[] = []): ViewNode {
    return { kind, key, label: key, direction, attrs, children };
}

const B = 'breaking';
const C = 'compatible';

/** A security section with requirements of the given keys (`none` is anonymous access). */
const security = (...keys: string[]) => node('section', 'request', {}, 'security', keys.map((key) => node('securityRequirement', 'request', {}, key)));

describe('classifyAdded', () => {
    const group = (key: string) => node('group', 'request', {}, key);
    const apiKey = node('securityRequirement', 'request', {}, 'apiKey');

    test.each<[string, ViewNode, Parameters<typeof classifyAdded>[1], string, string]>([
        ['endpoint', node('operation'), {}, C, 'endpoint added'],
        ['callback', node('callback'), {}, C, 'callback added'],
        ['required query parameter', node('parameter', 'request', { required: true }), { head: group('query') }, B, 'required query parameter added'],
        ['optional query parameter', node('parameter'), { head: group('query') }, C, 'optional query parameter added'],
        ['parameter of a webhook (client receives)', node('parameter', 'response', { required: true }), {}, C, 'parameter added'],
        ['required request body', node('requestBody', 'request', { required: true }), {}, B, 'required request body added'],
        ['optional request body', node('requestBody'), {}, C, 'optional request body added'],
        ['required request property', node('property', 'request', { required: true }), {}, B, 'required property added'],
        ['optional request property', node('property'), {}, C, 'optional property added'],
        ['required response property', node('property', 'response', { required: true }), {}, C, 'property added'],
        ['response header', node('header', 'response'), {}, C, 'header added'],
        ['response', node('response', 'response', {}, '201'), {}, C, 'response 201 added'],
        ['media type', node('mediaType', 'request', {}, 'application/xml'), {}, C, 'media type application/xml added'],
        ['items schema in a request', node('items'), {}, B, 'items schema added (client sends)'],
        ['items schema in a response', node('items', 'response'), {}, C, 'items schema added (client receives)'],
        ['additionalProperties schema in a request', node('additionalProperties'), {}, B, 'additional properties schema added (client sends)'],
        ['variant in a request', node('variant', 'request', {}, 'Cat'), {}, C, 'variant Cat added (client sends)'],
        ['variant in a response', node('variant', 'response', {}, 'Cat'), {}, B, 'variant Cat added (client receives)'],
        ['security where there was none', apiKey, { base: security(), head: security('apiKey') }, B, 'security added to an endpoint that had none'],
        ['security with no base section', apiKey, { head: security('apiKey') }, B, 'security added to an endpoint that had none'],
        ['optional security where there was none', apiKey, { head: security('none', 'apiKey') }, C, 'security alternative added'],
        ['security alternative', apiKey, { base: security('oauth'), head: security('oauth', 'apiKey') }, C, 'security alternative added'],
        ['anonymous access', node('securityRequirement', 'request', {}, 'none'), { base: security('apiKey') }, C, 'anonymous access added'],
        ['OAuth flow', node('oauthFlow', 'request', {}, 'deviceAuthorization'), {}, C, 'OAuth flow deviceAuthorization added'],
        ['additional properties schema where false was', node('additionalProperties', 'response'), { base: node('property', 'response', { additionalProperties: false }) }, C, 'additional properties allowed'],
    ])('%s', (_name, added, parents, severity, reason) => {
        expect(classifyAdded(added, parents)).toEqual({ severity, reason });
    });
});

describe('classifyRemoved', () => {
    const apiKey = node('securityRequirement', 'request', {}, 'apiKey');

    test.each<[string, ViewNode, Parameters<typeof classifyRemoved>[1], string, string]>([
        ['endpoint', node('operation'), {}, B, 'endpoint removed'],
        ['callback', node('callback'), {}, B, 'callback removed'],
        ['parameter', node('parameter'), { base: node('group', 'request', {}, 'header') }, B, 'header parameter removed'],
        ['request body', node('requestBody'), {}, B, 'request body removed'],
        ['request property', node('property'), {}, B, 'property removed'],
        ['response property', node('property', 'response'), {}, B, 'property removed'],
        ['response header', node('header', 'response'), {}, B, 'header removed'],
        ['success response', node('response', 'response', {}, '200'), {}, B, 'response 200 removed'],
        ['success range response', node('response', 'response', {}, '2XX'), {}, B, 'response 2XX removed'],
        ['redirect response', node('response', 'response', {}, '302'), {}, B, 'response 302 removed'],
        ['error response', node('response', 'response', {}, '404'), {}, C, 'response 404 removed'],
        ['default response', node('response', 'response', {}, 'DEFAULT'), {}, C, 'response DEFAULT removed'],
        ['media type', node('mediaType', 'response', {}, 'application/json'), {}, B, 'media type application/json removed'],
        ['items schema in a request', node('items'), {}, C, 'items schema removed (client sends)'],
        ['items schema in a response', node('items', 'response'), {}, B, 'items schema removed (client receives)'],
        ['variant in a request', node('variant', 'request', {}, 'Cat'), {}, B, 'variant Cat removed (client sends)'],
        ['variant in a response', node('variant', 'response', {}, 'Cat'), {}, C, 'variant Cat removed (client receives)'],
        ['security alternative', apiKey, { head: security('oauth') }, B, 'security alternative removed'],
        ['all security', apiKey, { head: security() }, C, 'security removed'],
        ['security section removed', apiKey, { base: security('apiKey') }, C, 'security removed'],
        ['security replaced by anonymous access', apiKey, { head: security('none') }, C, 'security removed'],
        ['anonymous access', node('securityRequirement', 'request', {}, 'none'), { head: security('apiKey') }, B, 'anonymous access removed'],
        ['OAuth flow', node('oauthFlow', 'request', {}, 'implicit'), {}, B, 'OAuth flow implicit removed'],
        ['additional properties schema replaced by false', node('additionalProperties'), { head: node('property', 'request', { additionalProperties: false }) }, C, 'additional properties schema removed'],
    ])('%s', (_name, removed, parents, severity, reason) => {
        expect(classifyRemoved(removed, parents)).toEqual({ severity, reason });
    });
});

describe('classifyAttr', () => {
    const req = (kind: NodeKind = 'property') => node(kind, 'request');
    const res = (kind: NodeKind = 'property') => node(kind, 'response');

    test.each<[string, Parameters<typeof classifyAttr>[0], unknown, unknown, ViewNode, string]>([
        // Documentation
        ['description changed', 'description', 'a', 'b', req(), C],
        ['summary changed', 'summary', 'a', 'b', req('operation'), C],
        ['deprecated', 'deprecated', undefined, true, req(), C],
        ['operationId changed', 'operationId', 'a', 'b', req('operation'), C],
        ['schema name changed', 'title', 'Pet', 'Animal', res(), C],
        ['example changed', 'example', 1, 2, res(), C],
        // Endpoints
        ['method changed', 'method', 'GET', 'POST', req('operation'), B],
        ['path changed', 'path', '/pets', '/animals', req('operation'), B],
        ['path parameter renamed', 'path', '/pets/{id}', '/pets/{petId}', req('operation'), C],
        ['server removed', 'servers', ['https://a'], ['https://b'], req('operation'), B],
        ['server added', 'servers', ['https://a'], ['https://a', 'https://b'], req('operation'), C],
        // Required
        ['request property became required', 'required', undefined, true, req(), B],
        ['request property became optional', 'required', true, undefined, req(), C],
        ['response property became optional', 'required', true, undefined, res(), B],
        ['response property became required', 'required', undefined, true, res(), C],
        ['request body became required', 'required', undefined, true, req('requestBody'), B],
        ['response header became optional', 'required', true, undefined, res('header'), B],
        // Serialization
        ['style changed', 'style', undefined, 'deepObject', req('parameter'), B],
        ['explode changed', 'explode', undefined, false, req('parameter'), B],
        ['allowReserved changed', 'allowReserved', undefined, true, req('parameter'), B],
        ['content media type changed', 'contentType', 'application/json', 'text/plain', req('parameter'), B],
        ['allowEmptyValue removed', 'allowEmptyValue', true, undefined, req('parameter'), B],
        ['allowEmptyValue added', 'allowEmptyValue', undefined, true, req('parameter'), C],
        // Types
        ['type changed to an unrelated type', 'type', ['string'], ['integer'], res(), B],
        ['type widened in a request', 'type', ['integer'], ['number'], req(), C],
        ['type widened in a response', 'type', ['integer'], ['number'], res(), B],
        ['type narrowed in a request', 'type', ['number'], ['integer'], req(), B],
        ['type narrowed in a response', 'type', ['number'], ['integer'], res(), C],
        ['null allowed in a request', 'type', ['string'], ['string', 'null'], req(), C],
        ['null allowed in a response', 'type', ['string'], ['string', 'null'], res(), B],
        ['null disallowed in a request', 'type', ['string', 'null'], ['string'], req(), B],
        ['null disallowed in a response', 'type', ['string', 'null'], ['string'], res(), C],
        ['type restricted in a request', 'type', undefined, ['string'], req(), B],
        // Format, pattern, const, content keywords
        ['format added in a request', 'format', undefined, 'email', req(), B],
        ['format added in a response', 'format', undefined, 'email', res(), C],
        ['format removed in a request', 'format', 'email', undefined, req(), C],
        ['format removed in a response', 'format', 'email', undefined, res(), B],
        ['format changed', 'format', 'int32', 'int64', req(), B],
        ['pattern added in a request', 'pattern', undefined, '^a', req(), B],
        ['pattern removed in a response', 'pattern', '^a', undefined, res(), B],
        ['pattern changed', 'pattern', '^a', '^b', res(), B],
        ['const added in a request', 'const', undefined, 'x', req(), B],
        ['const removed in a request', 'const', 'x', undefined, req(), C],
        ['const changed', 'const', 'x', 'y', res(), B],
        // Enums
        ['enum value added in a request', 'enum', ['a'], ['a', 'b'], req(), C],
        ['enum value added in a response', 'enum', ['a'], ['a', 'b'], res(), B],
        ['enum value removed in a request', 'enum', ['a', 'b'], ['a'], req(), B],
        ['enum value removed in a response', 'enum', ['a', 'b'], ['a'], res(), C],
        ['enum values swapped', 'enum', ['a'], ['b'], req(), B],
        ['enum added in a request', 'enum', undefined, ['a'], req(), B],
        ['enum removed in a response', 'enum', ['a'], undefined, res(), B],
        // Defaults
        ['default changed in a request', 'default', 1, 2, req(), B],
        ['default changed in a response', 'default', 1, 2, res(), C],
        ['default added', 'default', undefined, 2, req(), C],
        // Limits
        ['maximum decreased in a request', 'maximum', 500, 100, req(), B],
        ['maximum decreased in a response', 'maximum', 500, 100, res(), C],
        ['maximum increased in a request', 'maximum', 100, 500, req(), C],
        ['maximum increased in a response', 'maximum', 100, 500, res(), B],
        ['maxLength added in a request', 'maxLength', undefined, 10, req(), B],
        ['maxLength removed in a response', 'maxLength', 10, undefined, res(), B],
        ['minimum increased in a request', 'minimum', 0, 1, req(), B],
        ['minLength decreased in a request', 'minLength', 2, 1, req(), C],
        ['minItems increased in a response', 'minItems', 1, 2, res(), C],
        ['exclusiveMaximum decreased in a request', 'exclusiveMaximum', 10, 5, req(), B],
        ['maxProperties removed in a request', 'maxProperties', 5, undefined, req(), C],
        ['multipleOf to a divisor in a request', 'multipleOf', 4, 2, req(), C],
        ['multipleOf to a non-divisor in a request', 'multipleOf', 2, 3, req(), B],
        ['uniqueItems added in a request', 'uniqueItems', undefined, true, req(), B],
        ['uniqueItems removed in a response', 'uniqueItems', true, undefined, res(), B],
        // Objects and composition
        ['additionalProperties: false added in a request', 'additionalProperties', undefined, false, req(), B],
        ['additionalProperties: false added in a response', 'additionalProperties', undefined, false, res(), C],
        ['additionalProperties: false removed', 'additionalProperties', false, undefined, res(), C],
        ['composition changed', 'composition', 'oneOf', 'anyOf', req(), B],
        ['discriminator changed', 'discriminator', 'kind', 'type', res(), B],
        ['discriminator mapping added in a request', 'mapping', { cat: 'Cat' }, { cat: 'Cat', dog: 'Dog' }, req(), C],
        ['discriminator mapping added in a response', 'mapping', { cat: 'Cat' }, { cat: 'Cat', dog: 'Dog' }, res(), B],
        ['discriminator mapping removed in a request', 'mapping', { cat: 'Cat', dog: 'Dog' }, { cat: 'Cat' }, req(), B],
        ['discriminator mapping target changed', 'mapping', { cat: 'Cat' }, { cat: 'Feline' }, res(), B],
        ['recursive schema renamed', 'recursive', 'Node', 'Tree', res(), C],
        ['recursion replaced by a structure', 'recursive', 'Node', undefined, res(), B],
        ['null allowed without a type, in a response', 'nullable', undefined, true, res(), B],
        ['null no longer allowed without a type, in a response', 'nullable', true, undefined, res(), C],
        ['defaultMapping changed', 'defaultMapping', 'Cat', 'Dog', res(), B],
        // Security
        ['scope added', 'scopes', ['read'], ['read', 'write'], req('securityScheme'), B],
        ['scope removed', 'scopes', ['read', 'write'], ['read'], req('securityScheme'), C],
        ['security scheme type changed', 'schemeType', 'apiKey', 'http', req('securityScheme'), B],
        ['api key location changed', 'in', 'header', 'query', req('securityScheme'), B],
        ['api key name changed', 'parameterName', 'X-Key', 'X-API-Key', req('securityScheme'), B],
        ['oauth token URL changed', 'tokenUrl', 'https://a/token', 'https://b/token', req('oauthFlow'), B],
        ['oauth refresh URL added', 'refreshUrl', undefined, 'https://a/refresh', req('oauthFlow'), B],
        ['security scheme description changed', 'description', 'a', 'b', req('securityScheme'), C],
        // Documents
        ['document version changed', 'version', '1.0', '1.1', res('document'), C],
    ])('%s', (_name, attr, before, after, target, severity) => {
        expect(classifyAttr(attr, before, after, target).severity).toBe(severity);
    });

    test('reasons name the direction when the class depends on it', () => {
        expect(classifyAttr('maximum', 500, 100, req()).reason).toBe('maximum decreased (client sends)');
        expect(classifyAttr('enum', ['a'], ['a', 'b', 'c'], res()).reason).toBe('enum values added: b, c (client receives)');
        expect(classifyAttr('type', ['string'], ['string', 'null'], res()).reason).toBe('null allowed (client receives)');
    });
});

test('normalizePath ignores path parameter names, but not callback runtime expressions', () => {
    expect(normalizePath('/pets/{id}/toys/{toyId}')).toBe('/pets/{}/toys/{}');
    expect(normalizePath('{$request.body#/callbackUrl}')).toBe('{$request.body#/callbackUrl}');
});
