/**
 * The view tree: a version-independent, display-oriented model of one
 * OpenAPI document. Each endpoint is a tree of nodes (sections, parameters,
 * bodies, responses, schema properties). Each node holds typed attributes.
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
    | 'callback';

/** Structural nodes have no facts of their own. Their status follows their children. */
export const STRUCTURAL_KINDS: ReadonlySet<NodeKind> = new Set(['section', 'group']);

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
    /** apiKey: where the key goes (`header`, `query`, `cookie`). */
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
    /** The schema refers back to an enclosing schema with this name. The node has no children. */
    recursive?: string;
    /** The document is too large to expand this referenced schema here. It shows by name only. */
    truncated?: string;
    /** A `$ref` that does not resolve. */
    unresolved?: string;
}

export type AttrName = keyof Attrs;

export interface ViewNode {
    kind: NodeKind;
    /** Identifies the node among its siblings, and matches it with its counterpart in the other version. */
    key: string;
    /** Display name: a property name, a status code, a media type. */
    label: string;
    direction: Direction;
    attrs: Attrs;
    children: ViewNode[];
}

/** One OpenAPI document as view trees. */
export interface DocumentModel {
    /** A `document` node with the document facts: title, version, OpenAPI version, description, servers. */
    info: ViewNode;
    /** Operations under `paths`, in document order. */
    operations: ViewNode[];
    /** Operations under `webhooks`, in document order. */
    webhooks: ViewNode[];
    /** Problems that did not stop the build, for example unresolved references. */
    warnings: string[];
    /** How many nested `$ref` targets the schemas expand. `Infinity` for all of them. */
    refDepth: number;
}
