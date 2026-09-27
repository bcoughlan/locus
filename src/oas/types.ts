/**
 * Type definitions for the OpenAPI Specification 3.2, with the 3.0 fields that
 * 3.1 removed (`nullable`, boolean `exclusiveMinimum`/`exclusiveMaximum`).
 *
 * Adapted from apion (`src/lib/oas/oas32-types.ts`), which adapted
 * https://github.com/kogosoftwarellc/open-api/tree/master/packages/openapi-types
 *
 * Input documents are untrusted, so these types describe the expected shape,
 * not a checked one. Code reads fields through the guards in `../util.ts`.
 */

export interface Document {
    openapi: string;
    $self?: string;
    info: InfoObject;
    externalDocs?: ExternalDocumentationObject;
    servers?: ServerObject[];
    jsonSchemaDialect?: string;
    paths?: PathsObject;
    components?: ComponentsObject;
    security?: SecurityRequirementObject[];
    tags?: TagObject[];
    webhooks?: Record<string, PathItemObject | ReferenceObject>;
}

export interface InfoObject {
    title: string;
    description?: string;
    termsOfService?: string;
    contact?: ContactObject;
    summary?: string;
    license?: LicenseObject;
    version: string;
}

export interface ContactObject {
    name?: string;
    url?: string;
    email?: string;
}

export interface LicenseObject {
    name: string;
    url?: string;
    identifier?: string;
}

export interface ServerObject {
    url: string;
    description?: string;
    name?: string;
    variables?: Record<string, ServerVariableObject>;
}

export interface ServerVariableObject {
    enum?: [string, ...string[]];
    default: string;
    description?: string;
}

export type PathsObject = Record<string, PathItemObject | undefined>;

/** The fixed HTTP method fields of a Path Item Object. */
export const HttpMethods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query'] as const;

export type HttpMethod = (typeof HttpMethods)[number];

export type PathItemObject = {
    $ref?: string;
    summary?: string;
    description?: string;
    servers?: ServerObject[];
    parameters?: (ParameterObject | ReferenceObject)[];
    /** 3.2: operations for methods without a fixed field, keyed by method name. */
    additionalOperations?: Record<string, OperationObject | ReferenceObject>;
} & {
    [method in HttpMethod]?: OperationObject | ReferenceObject;
};

export interface OperationObject {
    tags?: string[];
    summary?: string;
    description?: string;
    externalDocs?: ExternalDocumentationObject;
    operationId?: string;
    parameters?: (ParameterObject | ReferenceObject)[];
    requestBody?: RequestBodyObject | ReferenceObject;
    responses?: ResponsesObject;
    callbacks?: Record<string, CallbackObject | ReferenceObject>;
    deprecated?: boolean;
    security?: SecurityRequirementObject[];
    servers?: ServerObject[];
}

export interface ExternalDocumentationObject {
    description?: string;
    url: string;
}

export interface ParameterObject extends ParameterBaseObject {
    name: string;
    in: ParameterLocation;
}

/** 3.2 adds `querystring`: one parameter that describes the whole query string. */
export type ParameterLocation = 'path' | 'query' | 'querystring' | 'header' | 'cookie';

export type HeaderObject = ParameterBaseObject;

export interface ParameterBaseObject {
    description?: string;
    required?: boolean;
    deprecated?: boolean;
    allowEmptyValue?: boolean;
    style?: string;
    explode?: boolean;
    allowReserved?: boolean;
    schema?: SchemaObject | ReferenceObject;
    example?: unknown;
    examples?: Record<string, ExampleObject | ReferenceObject>;
    content?: Record<string, MediaTypeObject>;
}

export type SchemaType = 'boolean' | 'object' | 'number' | 'string' | 'integer' | 'null' | 'array';

export interface SchemaObject {
    $ref?: string;
    $schema?: string;
    title?: string;
    description?: string;
    type?: SchemaType | SchemaType[];
    format?: string;
    default?: unknown;
    const?: unknown;
    enum?: unknown[];
    multipleOf?: number;
    maximum?: number;
    /** A number in 3.1+, a boolean modifier of `maximum` in 3.0. */
    exclusiveMaximum?: boolean | number;
    minimum?: number;
    /** A number in 3.1+, a boolean modifier of `minimum` in 3.0. */
    exclusiveMinimum?: boolean | number;
    maxLength?: number;
    minLength?: number;
    pattern?: string;
    maxItems?: number;
    minItems?: number;
    uniqueItems?: boolean;
    maxProperties?: number;
    minProperties?: number;
    required?: string[];
    properties?: Record<string, SchemaObject | ReferenceObject>;
    patternProperties?: Record<string, SchemaObject | ReferenceObject>;
    additionalProperties?: boolean | SchemaObject | ReferenceObject;
    items?: SchemaObject | ReferenceObject;
    prefixItems?: (SchemaObject | ReferenceObject)[];
    allOf?: (SchemaObject | ReferenceObject)[];
    oneOf?: (SchemaObject | ReferenceObject)[];
    anyOf?: (SchemaObject | ReferenceObject)[];
    not?: SchemaObject | ReferenceObject;
    contentMediaType?: string;
    contentEncoding?: string;

    // OpenAPI-specific keywords
    /** 3.0 only. 3.1+ lists `"null"` in `type` instead. */
    nullable?: boolean;
    discriminator?: DiscriminatorObject;
    readOnly?: boolean;
    writeOnly?: boolean;
    xml?: XMLObject;
    externalDocs?: ExternalDocumentationObject;
    /** Deprecated in 3.1+ in favor of `examples`. */
    example?: unknown;
    examples?: unknown[];
    deprecated?: boolean;
}

export interface DiscriminatorObject {
    propertyName: string;
    mapping?: Record<string, string>;
    /** 3.2: the schema to use when the discriminator value matches no mapping. */
    defaultMapping?: string;
}

export interface XMLObject {
    name?: string;
    namespace?: string;
    prefix?: string;
    attribute?: boolean;
    wrapped?: boolean;
    /** 3.2 */
    nodeType?: string;
}

export interface ReferenceObject {
    $ref: string;
    summary?: string;
    description?: string;
}

export interface ExampleObject {
    summary?: string;
    description?: string;
    value?: unknown;
    externalValue?: string;
    /** 3.2 */
    dataValue?: unknown;
    /** 3.2 */
    serializedValue?: string;
}

export interface MediaTypeObject {
    schema?: SchemaObject | ReferenceObject;
    /** 3.2: the schema of each item of a sequential media type, for example `application/jsonl`. */
    itemSchema?: SchemaObject | ReferenceObject;
    example?: unknown;
    examples?: Record<string, ExampleObject | ReferenceObject>;
    encoding?: Record<string, EncodingObject>;
}

export interface EncodingObject {
    contentType?: string;
    headers?: Record<string, HeaderObject | ReferenceObject>;
    style?: string;
    explode?: boolean;
    allowReserved?: boolean;
}

export interface RequestBodyObject {
    description?: string;
    content: Record<string, MediaTypeObject>;
    required?: boolean;
}

export type ResponsesObject = Record<string, ResponseObject | ReferenceObject>;

export interface ResponseObject {
    /** 3.2 */
    summary?: string;
    /** Required before 3.2. */
    description?: string;
    headers?: Record<string, HeaderObject | ReferenceObject>;
    content?: Record<string, MediaTypeObject>;
    links?: Record<string, LinkObject | ReferenceObject>;
}

export interface LinkObject {
    operationRef?: string;
    operationId?: string;
    parameters?: Record<string, unknown>;
    requestBody?: unknown;
    description?: string;
    server?: ServerObject;
}

export type CallbackObject = Record<string, PathItemObject>;

export type SecurityRequirementObject = Record<string, string[]>;

export interface ComponentsObject {
    schemas?: Record<string, SchemaObject>;
    responses?: Record<string, ResponseObject | ReferenceObject>;
    parameters?: Record<string, ParameterObject | ReferenceObject>;
    examples?: Record<string, ExampleObject | ReferenceObject>;
    requestBodies?: Record<string, RequestBodyObject | ReferenceObject>;
    headers?: Record<string, HeaderObject | ReferenceObject>;
    securitySchemes?: Record<string, SecuritySchemeObject | ReferenceObject>;
    links?: Record<string, LinkObject | ReferenceObject>;
    callbacks?: Record<string, CallbackObject | ReferenceObject>;
    pathItems?: Record<string, PathItemObject>;
    /** 3.2 */
    mediaTypes?: Record<string, MediaTypeObject | ReferenceObject>;
}

export type SecuritySchemeObject =
    | HttpSecurityScheme
    | ApiKeySecurityScheme
    | OAuth2SecurityScheme
    | OpenIdSecurityScheme
    | MutualTlsSecurityScheme;

interface SecuritySchemeBase {
    description?: string;
    /** 3.2 */
    deprecated?: boolean;
}

export interface HttpSecurityScheme extends SecuritySchemeBase {
    type: 'http';
    scheme: string;
    bearerFormat?: string;
}

export interface ApiKeySecurityScheme extends SecuritySchemeBase {
    type: 'apiKey';
    name: string;
    in: 'query' | 'header' | 'cookie';
}

export interface OAuthFlowObject {
    authorizationUrl?: string;
    /** 3.2: the device authorization flow. */
    deviceAuthorizationUrl?: string;
    tokenUrl?: string;
    refreshUrl?: string;
    scopes: Record<string, string>;
}

export interface OAuth2SecurityScheme extends SecuritySchemeBase {
    type: 'oauth2';
    flows: {
        implicit?: OAuthFlowObject;
        password?: OAuthFlowObject;
        clientCredentials?: OAuthFlowObject;
        authorizationCode?: OAuthFlowObject;
        /** 3.2 */
        deviceAuthorization?: OAuthFlowObject;
    };
    /** 3.2 */
    oauth2MetadataUrl?: string;
}

export interface OpenIdSecurityScheme extends SecuritySchemeBase {
    type: 'openIdConnect';
    openIdConnectUrl: string;
}

export interface MutualTlsSecurityScheme extends SecuritySchemeBase {
    type: 'mutualTLS';
}

export interface TagObject {
    name: string;
    /** 3.2 */
    summary?: string;
    description?: string;
    externalDocs?: ExternalDocumentationObject;
    /** 3.2 */
    parent?: string;
    /** 3.2 */
    kind?: string;
}
