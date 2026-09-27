/**
 * OpenAPI document to view trees: one tree per operation, a document node,
 * and a table of shared schema definitions.
 *
 * Every object read here can be a `$ref`, possibly into another file, so each
 * read goes through {@link deref}. Each value is {@link Located}: its place
 * becomes the `source` of its node. Untrusted input: malformed parts are
 * skipped, never thrown on.
 */
import type { DocumentStore } from '../load/documents.ts';
import type { Located } from '../load/located.ts';
import type { OasVersion } from '../load/version.ts';
import { defaultExplode, defaultStyle } from '../oas/serialization.ts';
import { HttpMethods } from '../oas/types.ts';
import { asObject, compact, getArray, getBoolean, getString, getStringArray, getText } from '../util.ts';
import { follow, schemaNode } from './schema.ts';
import type { BuildContext, SchemaScope } from './schema.ts';
import type { Attrs, Direction, DocumentModel, JsonValue, ViewNode } from './tree.ts';

/** An object read from a document, with its place. */
type Loc = Located<Record<string, unknown>>;

/** Operation context: the directions of its request and response parts. */
interface OperationScope {
    request: Direction;
    response: Direction;
    /** Security requirements that apply when the operation declares none. */
    defaultSecurity: unknown;
}

const PARAMETER_LOCATIONS = ['path', 'query', 'querystring', 'header', 'cookie'] as const;
const LOCATION_TITLES: Record<string, string> = {
    path: 'Path parameters',
    query: 'Query parameters',
    querystring: 'Query string',
    header: 'Header parameters',
    cookie: 'Cookie parameters',
};
/** The spec says that header parameters with these names are ignored. */
const IGNORED_HEADER_PARAMETERS = new Set(['accept', 'content-type', 'authorization']);

/** Build the view trees of the document in `file`. The store must hold the file and its references. */
export function buildDocument(store: DocumentStore, file: string, version: OasVersion): DocumentModel {
    const ctx: BuildContext = { store, root: store.document(file), family: version.family, warnings: new Set(), schemas: new Map() };
    const root = asObject(ctx.root.value) ?? {};
    const info = asObject(root.info) ?? {};
    const scope: OperationScope = { request: 'request', response: 'response', defaultSecurity: root.security };
    const flipped: OperationScope = { request: 'response', response: 'request', defaultSecurity: root.security };

    const infoNode: ViewNode = {
        kind: 'document',
        key: 'document',
        label: getText(info.title) ?? file,
        direction: 'response',
        // The `openapi` version is not a fact here: the model gives 3.0, 3.1, and 3.2 one meaning.
        attrs: compact({
            title: getText(info.title),
            version: getText(info.version),
            description: getText(info.description),
            servers: serverUrls(root.servers),
        }),
        children: [],
        source: ctx.root.at('info').source,
    };

    const pathItems = (container: string) =>
        entries(ctx.root.at(container)).flatMap(([name, raw]) => {
            const item = deref(ctx, raw);
            return item === undefined ? [] : [{ name, item }];
        });

    return {
        info: infoNode,
        operations: pathItems('paths').flatMap(({ name, item }) => pathItemOperations(ctx, name, item, scope)),
        webhooks: pathItems('webhooks').flatMap(({ name, item }) => pathItemOperations(ctx, name, item, flipped)),
        schemas: ctx.schemas,
        warnings: [...ctx.warnings],
    };
}

/** The operations of a path item: the fixed method fields, then 3.2 `additionalOperations`. */
function pathItemOperations(ctx: BuildContext, path: string, item: Loc, scope: OperationScope): ViewNode[] {
    const operations: ViewNode[] = [];
    for (const method of HttpMethods) {
        const op = deref(ctx, item.at(method));
        if (op !== undefined) {
            operations.push(buildOperation(ctx, method, path, item, op, scope));
        }
    }
    for (const [method, raw] of item.at('additionalOperations').entries()) {
        const op = deref(ctx, raw);
        if (op !== undefined) {
            operations.push(buildOperation(ctx, method, path, item, op, scope));
        }
    }
    return operations;
}

function buildOperation(ctx: BuildContext, method: string, path: string, item: Loc, op: Loc, scope: OperationScope): ViewNode {
    const upper = method.toUpperCase();
    const attrs = compact<Attrs>({
        method: upper,
        path,
        operationId: getText(op.value.operationId),
        summary: getText(op.value.summary) ?? getText(item.value.summary),
        description: getText(op.value.description) ?? getText(item.value.description),
        deprecated: op.value.deprecated === true ? true : undefined,
        tags: nonEmpty(getStringArray(op.value.tags)),
        servers: serverUrls(op.value.servers ?? item.value.servers),
    });

    const sections = [
        section('security', 'Security', securityNodes(ctx, op.value.security ?? scope.defaultSecurity, scope.request)),
        section('request', 'Request', requestNodes(ctx, path, item, op, scope.request), scope.request),
        section('responses', 'Responses', responseNodes(ctx, op, scope.response), scope.response),
        section('callbacks', 'Callbacks', callbackNodes(ctx, op, scope), scope.request),
    ].filter((node): node is ViewNode => node !== undefined);

    return { kind: 'operation', key: `${upper} ${path}`, label: `${upper} ${path}`, direction: scope.request, attrs, children: sections, source: op.source };
}

function section(key: string, label: string, children: ViewNode[], direction: Direction = 'request'): ViewNode | undefined {
    return children.length === 0 ? undefined : { kind: 'section', key, label, direction, attrs: {}, children };
}

// --- Security ---------------------------------------------------------------

/** One node per alternative security requirement, each with a node per scheme. */
function securityNodes(ctx: BuildContext, requirements: unknown, direction: Direction): ViewNode[] {
    const schemes = ctx.root.at('components', 'securitySchemes');
    return getArray(requirements).flatMap((raw) => {
        const requirement = asObject(raw);
        if (requirement === undefined) {
            return [];
        }
        const names = Object.keys(requirement);
        const key = names.length === 0 ? 'none' : [...names].sort().join(' + ');
        const label = names.length === 0 ? 'none (anonymous access)' : names.join(' + ');
        const children = names.map((name) => securitySchemeNode(ctx, name, schemes.at(name), requirement[name], direction));
        return [{ kind: 'securityRequirement', key, label, direction, attrs: {}, children }];
    });
}

function securitySchemeNode(ctx: BuildContext, name: string, raw: Located, scopes: unknown, direction: Direction): ViewNode {
    const scheme = deref(ctx, raw);
    const s = scheme?.value ?? {};
    const attrs = compact<Attrs>({
        schemeType: getString(s.type),
        in: getString(s.in),
        parameterName: getString(s.name),
        scheme: getString(s.scheme)?.toLowerCase(),
        bearerFormat: getString(s.bearerFormat),
        openIdConnectUrl: getString(s.openIdConnectUrl),
        oauth2MetadataUrl: getString(s.oauth2MetadataUrl),
        scopes: nonEmpty(getStringArray(scopes).sort()),
        description: getText(s.description),
        deprecated: s.deprecated === true ? true : undefined,
        unresolved: scheme === undefined ? `#/components/securitySchemes/${name}` : undefined,
    });
    // One child per OAuth flow, with its URLs. The scope descriptions are documentation, so they stay out.
    const flows = (scheme === undefined ? [] : entries(scheme.at('flows'))).map(([flowName, loc]): ViewNode => {
        const flow = asObject(loc.value) ?? {};
        const urls = compact<Attrs>({
            authorizationUrl: getString(flow.authorizationUrl),
            deviceAuthorizationUrl: getString(flow.deviceAuthorizationUrl),
            tokenUrl: getString(flow.tokenUrl),
            refreshUrl: getString(flow.refreshUrl),
        });
        return { kind: 'oauthFlow', key: flowName, label: flowName, direction, attrs: urls, children: [], source: loc.source };
    });
    return { kind: 'securityScheme', key: name, label: name, direction, attrs, children: flows, source: scheme?.source };
}

// --- Request ----------------------------------------------------------------

function requestNodes(ctx: BuildContext, path: string, item: Loc, op: Loc, direction: Direction): ViewNode[] {
    const parameters = new Map<string, Loc>();
    for (const holder of [item, op]) {
        for (const raw of holder.at('parameters').items()) {
            const param = deref(ctx, raw);
            const name = getString(param?.value.name);
            const location = getString(param?.value.in);
            if (param === undefined || name === undefined || location === undefined) {
                continue;
            }
            if (location === 'header' && IGNORED_HEADER_PARAMETERS.has(name.toLowerCase())) {
                continue;
            }
            // An operation parameter overrides a path item parameter with the same name and location.
            parameters.set(`${location}:${location === 'header' ? name.toLowerCase() : name}`, param);
        }
    }

    const groups: ViewNode[] = [];
    const pathNames = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    for (const location of PARAMETER_LOCATIONS) {
        const nodes = [...parameters.values()]
            .filter((param) => param.value.in === location)
            .map((param) => parameterNode(ctx, param, pathNames, direction));
        if (nodes.length > 0) {
            groups.push({ kind: 'group', key: location, label: LOCATION_TITLES[location], direction, attrs: {}, children: nodes });
        }
    }

    const body = deref(ctx, op.at('requestBody'));
    if (body !== undefined) {
        groups.push({
            kind: 'requestBody',
            key: 'body',
            label: 'Body',
            direction,
            attrs: compact({ required: body.value.required === true ? true : undefined, description: getText(body.value.description) }),
            children: mediaTypeNodes(ctx, body, direction),
            source: body.source,
        });
    }
    return groups;
}

function parameterNode(ctx: BuildContext, param: Loc, pathNames: string[], direction: Direction): ViewNode {
    const p = param.value;
    const name = String(p.name);
    const location = String(p.in);
    // A path parameter matches by its position in the path, so a rename is not a removal.
    const position = location === 'path' ? pathNames.indexOf(name) : -1;
    const key = position >= 0 ? `#${position}` : location === 'header' ? name.toLowerCase() : name;
    const own: Attrs = {
        in: location,
        required: location === 'path' || p.required === true ? true : undefined,
        deprecated: p.deprecated === true ? true : undefined,
        description: getText(p.description),
        ...serialization(p, location),
        allowEmptyValue: p.allowEmptyValue === true ? true : undefined,
        allowReserved: p.allowReserved === true ? true : undefined,
        example: p.example as JsonValue | undefined,
        examples: exampleValues(ctx, param.at('examples')),
    };
    return valueNode(ctx, 'parameter', key, name, param, own, direction);
}

/**
 * The effective `style` and `explode`, so an explicit default compares equal
 * to an omitted one. The renderer hides the defaults. A `querystring`
 * parameter has neither.
 */
function serialization(p: Record<string, unknown>, location: string): Attrs {
    if (location === 'querystring') {
        return {};
    }
    const style = getString(p.style) ?? defaultStyle(location);
    return { style, explode: getBoolean(p.explode) ?? defaultExplode(style) };
}

/**
 * A parameter or header node. Its schema comes from `schema`, or from the
 * single media type of `content`. The node's source is the parameter or
 * header itself, not its schema.
 */
function valueNode(ctx: BuildContext, kind: 'parameter' | 'header', key: string, label: string, holder: Loc, own: Attrs, direction: Direction): ViewNode {
    let schema: Located | undefined = holder.value.schema === undefined ? undefined : holder.at('schema');
    const [content] = holder.at('content').entries();
    if (schema === undefined && content !== undefined) {
        const [mediaType, raw] = content;
        own.contentType = mediaType;
        const media = deref(ctx, raw);
        if (media?.value.schema !== undefined) {
            schema = media.at('schema');
        }
    }
    const node = schemaNode(kind, key, label, schema === undefined ? [] : [schema], schemaScope(direction), ctx, compact(own));
    return { ...node, source: holder.source };
}

// --- Responses --------------------------------------------------------------

function responseNodes(ctx: BuildContext, op: Loc, direction: Direction): ViewNode[] {
    return entries(op.at('responses'))
        .sort(([a], [b]) => compareStatusCodes(a, b))
        .flatMap(([code, raw]) => {
            const response = deref(ctx, raw);
            if (response === undefined) {
                return [];
            }
            const headers = response.at('headers').entries()
                .filter(([name]) => name.toLowerCase() !== 'content-type')
                .flatMap(([name, rawHeader]) => {
                    const header = deref(ctx, rawHeader);
                    return header === undefined ? [] : [headerNode(ctx, name, header, direction)];
                });
            const children: ViewNode[] = [];
            if (headers.length > 0) {
                children.push({ kind: 'group', key: 'headers', label: 'Headers', direction, attrs: {}, children: headers });
            }
            children.push(...mediaTypeNodes(ctx, response, direction));
            const node: ViewNode = {
                kind: 'response',
                key: code.toUpperCase(),
                label: code,
                direction,
                attrs: compact({ summary: getText(response.value.summary), description: getText(response.value.description) }),
                children,
                source: response.source,
            };
            return [node];
        });
}

function headerNode(ctx: BuildContext, name: string, header: Loc, direction: Direction): ViewNode {
    const h = header.value;
    const own: Attrs = {
        in: 'header',
        required: h.required === true ? true : undefined,
        deprecated: h.deprecated === true ? true : undefined,
        description: getText(h.description),
        ...serialization(h, 'header'),
        example: h.example as JsonValue | undefined,
        examples: exampleValues(ctx, header.at('examples')),
    };
    return valueNode(ctx, 'header', name.toLowerCase(), name, header, own, direction);
}

/** Exact codes in numeric order, then ranges (`2XX`), then `default`. */
export function compareStatusCodes(a: string, b: string): number {
    const rank = (code: string) => {
        const upper = code.toUpperCase();
        if (upper === 'DEFAULT') {
            return [9, 9];
        }
        return [Number(upper[0]) || 8, /^\d{3}$/.test(upper) ? Number(upper) % 100 : 100];
    };
    const [a1, a2] = rank(a);
    const [b1, b2] = rank(b);
    return a1 - b1 || a2 - b2 || a.localeCompare(b);
}

// --- Media types ------------------------------------------------------------

/** One node per media type of a `content` map (request body or response). */
function mediaTypeNodes(ctx: BuildContext, holder: Loc, direction: Direction): ViewNode[] {
    const scope = schemaScope(direction);
    return holder.at('content').entries().flatMap(([mediaType, raw]) => {
        const media = deref(ctx, raw);
        if (media === undefined) {
            return [];
        }
        const m = media.value;
        const own = compact<Attrs>({
            example: m.example as JsonValue | undefined,
            examples: exampleValues(ctx, media.at('examples')),
        });
        const schemas = m.schema === undefined ? [] : [media.at('schema')];
        const node = { ...schemaNode('mediaType', mediaType.toLowerCase(), mediaType, schemas, scope, ctx, own), source: media.source };
        if (m.itemSchema !== undefined) {
            // A 3.2 sequential media type: one schema per item of the stream.
            node.children = [...node.children, schemaNode('items', 'itemSchema', 'each item', [media.at('itemSchema')], scope, ctx)];
        }
        return [node];
    });
}

/** Named examples with their values. The model shows the names and compares the values. */
function exampleValues(ctx: BuildContext, examples: Located): Record<string, JsonValue> | undefined {
    const list = examples.entries().map(([name, raw]) => {
        const example = deref(ctx, raw)?.value ?? {};
        const value = example.dataValue ?? example.value ?? example.serializedValue ?? example.externalValue ?? null;
        return [name, value as JsonValue] as const;
    });
    return list.length === 0 ? undefined : Object.fromEntries(list);
}

// --- Callbacks --------------------------------------------------------------

/** Callbacks: the API sends the callback request, so the directions flip. */
function callbackNodes(ctx: BuildContext, op: Loc, scope: OperationScope): ViewNode[] {
    const flipped: OperationScope = { request: scope.response, response: scope.request, defaultSecurity: undefined };
    return op.at('callbacks').entries().flatMap(([name, raw]) => {
        const callback = deref(ctx, raw);
        if (callback === undefined) {
            return [];
        }
        const operations = entries(callback).flatMap(([expression, rawItem]) => {
            const item = deref(ctx, rawItem);
            return item === undefined ? [] : pathItemOperations(ctx, expression, item, flipped);
        });
        const node: ViewNode = { kind: 'callback', key: name, label: name, direction: flipped.request, attrs: {}, children: operations, source: callback.source };
        return [node];
    });
}

// --- Helpers ----------------------------------------------------------------

/**
 * Resolve a possibly-referenced object. `undefined` when absent, unresolved,
 * or not an object. The result has the place of the target. A `summary` or
 * `description` next to the `$ref` overrides the one of the target (3.1
 * Reference Object).
 */
function deref(ctx: BuildContext, loc: Located): Loc | undefined {
    if (loc.value === undefined) {
        return undefined;
    }
    const resolved = follow(ctx, loc);
    if (resolved.unresolved !== undefined) {
        return undefined;
    }
    const value = asObject(resolved.target.value);
    if (value === undefined) {
        return undefined;
    }
    const reference = asObject(loc.value);
    const overrides = resolved.name === undefined ? {} : compact({ summary: reference?.summary, description: reference?.description });
    return resolved.target.with({ ...value, ...overrides });
}

/** The entries of an object map, without specification extensions (`x-*`). */
function entries(loc: Located): [string, Located][] {
    return loc.entries().filter(([key]) => !key.startsWith('x-'));
}

function schemaScope(direction: Direction): SchemaScope {
    return { direction, depth: 0 };
}

function serverUrls(servers: unknown): string[] | undefined {
    return nonEmpty(getArray(servers).flatMap((server) => getString(asObject(server)?.url) ?? []));
}

function nonEmpty<T>(list: T[]): T[] | undefined {
    return list.length === 0 ? undefined : list;
}
