/**
 * OpenAPI document to view trees: one tree per operation, plus a document node.
 *
 * Every object read here can be a `$ref`, possibly into another file, so each
 * read goes through {@link DocumentStore.deref} with the file that holds the
 * reference. Untrusted input: malformed parts are skipped, never thrown on.
 */
import type { DocumentStore } from '../load/documents.ts';
import type { OasVersion } from '../load/version.ts';
import { HttpMethods } from '../oas/types.ts';
import { asObject, getArray, getBoolean, getString, getStringArray, getText } from '../util.ts';
import { buildSchemaNode, flatten, schemaNode, topLevel } from './schema.ts';
import type { BuildContext, Located, SchemaScope } from './schema.ts';
import type { Attrs, Direction, DocumentModel, JsonValue, ViewNode } from './tree.ts';

/** An object read from a document, with the file that holds it. */
interface Loc {
    value: Record<string, unknown>;
    file: string;
}

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
const NORMAL: OperationScope = { request: 'request', response: 'response', defaultSecurity: undefined };

/** Build the view trees of the document in `file`. The store must hold the file and its references. */
export function buildDocument(store: DocumentStore, file: string, version: OasVersion): DocumentModel {
    const ctx: BuildContext = { store, rootFile: file, family: version.family, warnings: new Set() };
    const root = asObject(store.document(file)) ?? {};
    const info = asObject(root.info) ?? {};
    const scope: OperationScope = { ...NORMAL, defaultSecurity: root.security };
    const flipped: OperationScope = { request: 'response', response: 'request', defaultSecurity: root.security };

    const infoNode: ViewNode = {
        kind: 'document',
        key: 'document',
        label: getText(info.title) ?? file,
        direction: 'response',
        attrs: compact({
            title: getText(info.title),
            version: getText(info.version),
            openapi: version.raw,
            description: getText(info.description),
            servers: serverUrls(root.servers),
        }),
        children: [],
    };

    const pathItems = (container: unknown) =>
        entries(container).flatMap(([name, raw]) => {
            const item = deref(ctx, raw, file);
            return item === undefined ? [] : [{ name, item }];
        });

    return {
        info: infoNode,
        operations: pathItems(root.paths).flatMap(({ name, item }) => pathItemOperations(ctx, name, item, scope)),
        webhooks: pathItems(root.webhooks).flatMap(({ name, item }) => pathItemOperations(ctx, name, item, flipped)),
        warnings: [...ctx.warnings],
    };
}

/** The operations of a path item: the fixed method fields, then 3.2 `additionalOperations`. */
function pathItemOperations(ctx: BuildContext, path: string, item: Loc, scope: OperationScope): ViewNode[] {
    const operations: ViewNode[] = [];
    for (const method of HttpMethods) {
        const op = deref(ctx, item.value[method], item.file);
        if (op !== undefined) {
            operations.push(buildOperation(ctx, method, path, item, op, scope));
        }
    }
    for (const [method, raw] of Object.entries(asObject(item.value.additionalOperations) ?? {})) {
        const op = deref(ctx, raw, item.file);
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

    return { kind: 'operation', key: `${upper} ${path}`, label: `${upper} ${path}`, direction: scope.request, attrs, children: sections };
}

function section(key: string, label: string, children: ViewNode[], direction: Direction = 'request'): ViewNode | undefined {
    return children.length === 0 ? undefined : { kind: 'section', key, label, direction, attrs: {}, children };
}

// --- Security ---------------------------------------------------------------

/** One node per alternative security requirement, each with a node per scheme. */
function securityNodes(ctx: BuildContext, requirements: unknown, direction: Direction): ViewNode[] {
    const root = asObject(ctx.store.document(ctx.rootFile)) ?? {};
    const schemes = asObject(asObject(root.components)?.securitySchemes) ?? {};
    return getArray(requirements).flatMap((raw) => {
        const requirement = asObject(raw);
        if (requirement === undefined) {
            return [];
        }
        const names = Object.keys(requirement);
        const key = names.length === 0 ? 'none' : [...names].sort().join(' + ');
        const label = names.length === 0 ? 'none (anonymous access)' : names.join(' + ');
        const children = names.map((name) => securitySchemeNode(ctx, name, schemes[name], requirement[name], direction));
        return [{ kind: 'securityRequirement', key, label, direction, attrs: {}, children }];
    });
}

function securitySchemeNode(ctx: BuildContext, name: string, raw: unknown, scopes: unknown, direction: Direction): ViewNode {
    const scheme = deref(ctx, raw, ctx.rootFile);
    const s = scheme?.value ?? {};
    const flows = asObject(s.flows);
    const attrs = compact<Attrs>({
        schemeType: getString(s.type),
        in: getString(s.in),
        parameterName: getString(s.name),
        scheme: getString(s.scheme)?.toLowerCase(),
        bearerFormat: getString(s.bearerFormat),
        openIdConnectUrl: getString(s.openIdConnectUrl),
        oauth2MetadataUrl: getString(s.oauth2MetadataUrl),
        flows: flows === undefined ? undefined : flowUrls(flows),
        scopes: nonEmpty(getStringArray(scopes).sort()),
        description: getText(s.description),
        deprecated: s.deprecated === true ? true : undefined,
        unresolved: scheme === undefined ? `#/components/securitySchemes/${name}` : undefined,
    });
    return { kind: 'securityScheme', key: name, label: name, direction, attrs, children: [] };
}

/** OAuth flows with their URLs only. The scope descriptions are documentation, so they stay out. */
function flowUrls(flows: Record<string, unknown>): Record<string, JsonValue> {
    const out: Record<string, JsonValue> = {};
    for (const [name, raw] of Object.entries(flows)) {
        const flow = asObject(raw) ?? {};
        out[name] = compact({
            authorizationUrl: getString(flow.authorizationUrl),
            deviceAuthorizationUrl: getString(flow.deviceAuthorizationUrl),
            tokenUrl: getString(flow.tokenUrl),
            refreshUrl: getString(flow.refreshUrl),
        }) as Record<string, string>;
    }
    return out;
}

// --- Request ----------------------------------------------------------------

function requestNodes(ctx: BuildContext, path: string, item: Loc, op: Loc, direction: Direction): ViewNode[] {
    const parameters = new Map<string, Loc>();
    for (const holder of [item, op]) {
        for (const raw of getArray(holder.value.parameters)) {
            const param = deref(ctx, raw, holder.file);
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

    const body = deref(ctx, op.value.requestBody, op.file);
    if (body !== undefined) {
        groups.push({
            kind: 'requestBody',
            key: 'body',
            label: 'Body',
            direction,
            attrs: compact({ required: body.value.required === true ? true : undefined, description: getText(body.value.description) }),
            children: mediaTypeNodes(ctx, body, direction),
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
        required: location === 'path' || p.required === true ? true : undefined,
        deprecated: p.deprecated === true ? true : undefined,
        description: getText(p.description),
        ...serialization(p, location),
        allowEmptyValue: p.allowEmptyValue === true ? true : undefined,
        allowReserved: p.allowReserved === true ? true : undefined,
        example: p.example as JsonValue | undefined,
        examples: exampleValues(ctx, p.examples, param.file),
    };
    return valueNode(ctx, 'parameter', key, name, param, own, direction);
}

/**
 * `style` and `explode` when they differ from the default of the location.
 * Explicit defaults then compare equal to omitted ones.
 */
function serialization(p: Record<string, unknown>, location: string): Attrs {
    const defaultStyle = location === 'query' || location === 'cookie' ? 'form' : 'simple';
    const style = getString(p.style) ?? defaultStyle;
    const explode = getBoolean(p.explode) ?? style === 'form';
    return compact({
        style: style === defaultStyle ? undefined : style,
        explode: explode === (style === 'form') ? undefined : explode,
    });
}

/**
 * A parameter or header node. Its schema comes from `schema`, or from the
 * single media type of `content`.
 */
function valueNode(ctx: BuildContext, kind: 'parameter' | 'header', key: string, label: string, holder: Loc, own: Attrs, direction: Direction): ViewNode {
    const content = Object.entries(asObject(holder.value.content) ?? {});
    let schema: Located | undefined = holder.value.schema === undefined ? undefined : topLevel(holder.value.schema, holder.file);
    if (schema === undefined && content.length > 0) {
        const [mediaType, raw] = content[0];
        own.contentType = mediaType;
        const media = deref(ctx, raw, holder.file);
        if (media?.value.schema !== undefined) {
            schema = topLevel(media.value.schema, media.file);
        }
    }
    const scope = schemaScope(direction);
    return buildSchemaNode(kind, key, label, schema === undefined ? [] : [schema], scope, ctx, compact(own));
}

// --- Responses --------------------------------------------------------------

function responseNodes(ctx: BuildContext, op: Loc, direction: Direction): ViewNode[] {
    return entries(op.value.responses)
        .sort(([a], [b]) => compareStatusCodes(a, b))
        .flatMap(([code, raw]) => {
            const response = deref(ctx, raw, op.file);
            if (response === undefined) {
                return [];
            }
            const headers = Object.entries(asObject(response.value.headers) ?? {})
                .filter(([name]) => name.toLowerCase() !== 'content-type')
                .flatMap(([name, rawHeader]) => {
                    const header = deref(ctx, rawHeader, response.file);
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
                label: code.toUpperCase(),
                direction,
                attrs: compact({ summary: getText(response.value.summary), description: getText(response.value.description) }),
                children,
            };
            return [node];
        });
}

function headerNode(ctx: BuildContext, name: string, header: Loc, direction: Direction): ViewNode {
    const h = header.value;
    const own: Attrs = {
        required: h.required === true ? true : undefined,
        deprecated: h.deprecated === true ? true : undefined,
        description: getText(h.description),
        ...serialization(h, 'header'),
        example: h.example as JsonValue | undefined,
        examples: exampleValues(ctx, h.examples, header.file),
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
    return Object.entries(asObject(holder.value.content) ?? {}).flatMap(([mediaType, raw]) => {
        const media = deref(ctx, raw, holder.file);
        if (media === undefined) {
            return [];
        }
        const m = media.value;
        const own = compact<Attrs>({
            example: m.example as JsonValue | undefined,
            examples: exampleValues(ctx, m.examples, media.file),
        });
        const schemas = m.schema === undefined ? [] : [topLevel(m.schema, media.file)];
        const node = schemaNode('mediaType', mediaType.toLowerCase(), mediaType, flatten(schemas, ctx), scope, ctx, own);
        if (m.itemSchema !== undefined) {
            node.children.push(buildSchemaNode('items', 'itemSchema', 'each item', [topLevel(m.itemSchema, media.file)], scope, ctx));
        }
        return [node];
    });
}

/** Named examples with their values. The model shows the names and compares the values. */
function exampleValues(ctx: BuildContext, examples: unknown, file: string): Record<string, JsonValue> | undefined {
    const entries = Object.entries(asObject(examples) ?? {}).map(([name, raw]) => {
        const example = deref(ctx, raw, file)?.value ?? {};
        const value = example.dataValue ?? example.value ?? example.serializedValue ?? example.externalValue ?? null;
        return [name, value as JsonValue] as const;
    });
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

// --- Callbacks --------------------------------------------------------------

/** Callbacks: the API sends the callback request, so the directions flip. */
function callbackNodes(ctx: BuildContext, op: Loc, scope: OperationScope): ViewNode[] {
    const flipped: OperationScope = { request: scope.response, response: scope.request, defaultSecurity: undefined };
    return Object.entries(asObject(op.value.callbacks) ?? {}).flatMap(([name, raw]) => {
        const callback = deref(ctx, raw, op.file);
        if (callback === undefined) {
            return [];
        }
        const operations = entries(callback.value).flatMap(([expression, rawItem]) => {
            const item = deref(ctx, rawItem, callback.file);
            return item === undefined ? [] : pathItemOperations(ctx, expression, item, flipped);
        });
        return [{ kind: 'callback', key: name, label: name, direction: flipped.request, attrs: {}, children: operations }];
    });
}

// --- Helpers ----------------------------------------------------------------

/**
 * Resolve a possibly-referenced object. `undefined` when absent, unresolved,
 * or not an object. A `summary` or `description` next to the `$ref` overrides
 * the one of the target (3.1 Reference Object).
 */
function deref(ctx: BuildContext, raw: unknown, file: string): Loc | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const target = ctx.store.deref(raw, file);
    if (target.unresolved !== undefined) {
        ctx.warnings.add(`Unresolved $ref "${target.unresolved}" in ${file}${target.reason ? ` (${target.reason})` : ''}`);
        return undefined;
    }
    const value = asObject(target.value);
    if (value === undefined) {
        return undefined;
    }
    const reference = asObject(raw);
    const overrides = target.key === undefined ? {} : compact({ summary: reference?.summary, description: reference?.description });
    return { value: { ...value, ...overrides }, file: target.file };
}

/** The entries of an object map, without specification extensions (`x-*`). */
function entries(value: unknown): [string, unknown][] {
    return Object.entries(asObject(value) ?? {}).filter(([key]) => !key.startsWith('x-'));
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

/** A copy without `undefined` values, so absent facts compare equal to omitted ones. */
function compact<T extends object>(attrs: T): T {
    return Object.fromEntries(Object.entries(attrs).filter(([, value]) => value !== undefined)) as T;
}
