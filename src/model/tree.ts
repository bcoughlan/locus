/**
 * The view tree: a version-independent, display-oriented model of one
 * OpenAPI document. Each endpoint is a tree of nodes (sections, parameters,
 * bodies, responses, schema properties). Each node holds typed attributes.
 *
 * A `$ref` to a schema stays a reference: the node names a shared schema
 * definition in {@link DocumentModel.schemas}, which the model builds once.
 * The diff compares each pair of definitions once, and the renderers expand
 * references while they print.
 *
 * The diff compares two view trees node by node, and the renderers print the
 * result. Because both use the same tree, every change the diff finds is
 * visible, and every visible fact takes part in the diff.
 */

/**
 * Who writes a value. `request`: the client writes it and the server reads it.
 * `response`: the server writes it and the client reads it. Webhooks and
 * callbacks flip both.
 */
export type Direction = 'request' | 'response';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type NodeKind =
    /** The document facts (`info`, servers). */
    | 'document'
    /** Structural: a titled block of an operation (security, request, responses, callbacks). */
    | 'section'
    /** Structural: a list of parameters of one location, or of response headers. */
    | 'group'
    | 'operation'
    | 'securityRequirement'
    | 'securityScheme'
    /** One OAuth 2 flow of a security scheme, with its URLs. */
    | 'oauthFlow'
    | 'parameter'
    | 'requestBody'
    | 'response'
    | 'header'
    | 'mediaType'
    | 'property'
    /** Array items, a `prefixItems` entry, or a 3.2 `itemSchema`. */
    | 'items'
    | 'additionalProperties'
    | 'patternProperty'
    /** A `oneOf` or `anyOf` member. */
    | 'variant'
    | 'not'
    | 'callback'
    /** A schema definition in {@link DocumentModel.schemas}: the target of `$ref`s. */
    | 'schema';

/** Structural nodes have no facts of their own. Their status follows their children. */
export const STRUCTURAL_KINDS: ReadonlySet<NodeKind> = new Set(['section', 'group']);

const TYPE_ORDER = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];

/** JSON Schema types in a canonical order, without repeats. */
export function sortTypes(types: string[]): string[] {
    const rank = (type: string) => (TYPE_ORDER.includes(type) ? TYPE_ORDER.indexOf(type) : TYPE_ORDER.length);
    return [...new Set(types)].sort((a, b) => rank(a) - rank(b));
}

/**
 * A reference node with its definition merged in: the effective facts, the
 * definition's children (then any own children), and the properties that
 * the definition leaves out for this direction. The `ref` stays.
 */
export function expandReference(node: ViewNode, definitionOf: (ref: string) => ViewNode | undefined): ViewNode {
    const definition = node.ref === undefined ? undefined : definitionOf(node.ref);
    if (definition === undefined) {
        return node;
    }
    return {
        ...node,
        attrs: effectiveAttrs(node, definitionOf),
        children: [...definition.children, ...node.children],
        omitted: definition.omitted,
    };
}

/**
 * The facts that a node shows: the facts of its definition, under its own.
 * A nullable reference adds "null" to the definition's types. Works for view
 * nodes and diff nodes: `definitionOf` looks up the definition by `ref`.
 */
export function effectiveAttrs(node: { attrs: Attrs; ref?: string }, definitionOf: (ref: string) => { attrs: Attrs } | undefined): Attrs {
    const definition = node.ref === undefined ? undefined : definitionOf(node.ref);
    if (definition === undefined) {
        return node.attrs;
    }
    const attrs: Attrs = { ...definition.attrs, ...node.attrs };
    if (node.attrs.nullable && definition.attrs.type !== undefined) {
        attrs.type = sortTypes([...definition.attrs.type, 'null']);
        delete attrs.nullable;
    }
    return attrs;
}

export interface Attrs {
    // Documents
    /** `info.version`. */
    version?: string;

    // Operations
    method?: string;
    path?: string;
    operationId?: string;
    tags?: string[];
    servers?: string[];

    // Text shared by many kinds
    summary?: string;
    description?: string;
    deprecated?: boolean;

    // Parameters, headers, request bodies, properties
    required?: boolean;
    style?: string;
    explode?: boolean;
    allowEmptyValue?: boolean;
    allowReserved?: boolean;
    /** Media type of a parameter or header that uses `content` instead of `schema`. */
    contentType?: string;
    examples?: Record<string, JsonValue>;

    // Security schemes
    schemeType?: string;
    /** Parameters and headers: their location. apiKey schemes: where the key goes (`header`, `query`, `cookie`). */
    in?: string;
    /** apiKey: the name of the header, query parameter, or cookie. */
    parameterName?: string;
    scheme?: string;
    bearerFormat?: string;
    openIdConnectUrl?: string;
    oauth2MetadataUrl?: string;
    /** OAuth scopes that the requirement asks for. */
    scopes?: string[];

    // OAuth flows
    authorizationUrl?: string;
    /** 3.2: the device authorization flow. */
    deviceAuthorizationUrl?: string;
    tokenUrl?: string;
    refreshUrl?: string;

    // Schemas
    /** Schema name: the `title`, or else the name of the `$ref` target. */
    title?: string;
    /** JSON Schema types, in a canonical order. `integer` and `number` stay distinct. */
    type?: string[];
    /** Null is allowed, for a schema without a known type (for example a nullable `oneOf`). Otherwise `type` holds "null". */
    nullable?: true;
    format?: string;
    enum?: JsonValue[];
    const?: JsonValue;
    default?: JsonValue;
    example?: JsonValue;
    readOnly?: boolean;
    writeOnly?: boolean;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    multipleOf?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
    minProperties?: number;
    maxProperties?: number;
    contentMediaType?: string;
    contentEncoding?: string;
    /** Present (as `false`) only when the schema forbids unknown properties. */
    additionalProperties?: false;
    /** Set when the schema has `oneOf` or `anyOf` variant children. */
    composition?: 'oneOf' | 'anyOf';
    discriminator?: string;
    /** Discriminator values mapped to schema names. */
    mapping?: Record<string, string>;
    /** 3.2: the schema for discriminator values without a mapping. */
    defaultMapping?: string;
    /** A `$ref` that does not resolve. */
    unresolved?: string;
}

export type AttrName = keyof Attrs;

/** Where a node is defined: a file and a JSON pointer into it. A UI can turn it into a line (`DocumentStore.lineOf`). */
export interface Source {
    /** Absolute path of the file. */
    file: string;
    /** JSON pointer, for example `#/components/schemas/Pet/properties/name`. */
    pointer: string;
}

export interface ViewNode {
    kind: NodeKind;
    /** Identifies the node among its siblings, and matches it with its counterpart in the other version. */
    key: string;
    /** Display name: a property name, a status code, a media type. */
    label: string;
    direction: Direction;
    /** The node's own facts. For a node with `ref`, the definition holds the schema facts. */
    attrs: Attrs;
    children: ViewNode[];
    /**
     * The id of a schema definition in {@link DocumentModel.schemas}. The node
     * shows that schema: its facts (under the node's own facts) and its
     * children. Such a node has no children of its own.
     */
    ref?: string;
    source?: Source;
    /**
     * Properties that the schema has but this direction leaves out: readOnly
     * ones in requests, writeOnly ones in responses. The rules use it to
     * explain why a property disappeared.
     */
    omitted?: Record<string, 'readOnly' | 'writeOnly'>;
}

/** One OpenAPI document as view trees. */
export interface DocumentModel {
    /** A `document` node with the document facts: title, version, description, servers. */
    info: ViewNode;
    /** Operations under `paths`, in document order. */
    operations: ViewNode[];
    /** Operations under `webhooks`, in document order. */
    webhooks: ViewNode[];
    /**
     * Schema definitions by id (`<direction> <file>#<pointer>`): the targets of
     * the `ref`s in the trees. One per schema and direction, because a
     * readOnly property shows in responses only.
     */
    schemas: Map<string, ViewNode>;
    /** Problems that did not stop the build, for example unresolved references. */
    warnings: string[];
}
