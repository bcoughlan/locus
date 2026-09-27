# Breaking changes

This document lists each change that `locus diff` detects and how it classifies the change. The rules table in `src/diff/rules.ts` implements this list.

## Definitions

A breaking change is a change after which a client that worked with the base version can fail with the head version. The client code stays the same. A failure is a rejected request, a response that the client cannot read, or a value that the server silently ignores.

A compatible change is any other change.

Direction tells who writes a value and who reads it.

- A request value is a value that the client writes and the server reads. Parameters and request bodies hold request values.
- A response value is a value that the server writes and the client reads. Response bodies and response headers hold response values.
- Webhooks and callbacks flip the directions. The API writes the webhook request, and the consumer reads it. Thus a webhook request body holds response values, and a webhook response holds request values.

The general principle follows from direction. A request value can accept more over time, but it cannot accept less. A response value can promise more over time, but it cannot promise less.

## Colors

| Color | Meaning |
| --- | --- |
| Red | A breaking change. |
| Green | A compatible addition. |
| Orange | A compatible change or a compatible removal. |

An added item can be red. For example, a new required query parameter is an addition, but it is breaking.

## Endpoints

The tool matches endpoints by `operationId` first. It matches the remaining endpoints by method and path. The path match ignores the names of path parameters, so `/pets/{id}` matches `/pets/{petId}`.

| Change | Class |
| --- | --- |
| Endpoint removed | Breaking |
| Endpoint added | Compatible |
| Method changed (same `operationId`) | Breaking |
| Path changed (same `operationId`) | Breaking |
| Only the name of a path parameter changed | Compatible |
| `operationId` changed | Compatible. The request stays the same, but generated client code changes its method names. |
| Endpoint deprecated, or deprecation removed | Compatible |
| Summary, description, or tags changed | Compatible |

## Parameters

Parameters hold request values. The tool matches parameters by location (`in`) and name. A change of location or name is a removal plus an addition. Path parameters are the exception: the tool matches them by their position in the path. The OpenAPI 3.2 `querystring` location follows the same rules as the other locations.

| Change | Class |
| --- | --- |
| Required parameter added | Breaking |
| Optional parameter added | Compatible |
| Parameter removed | Breaking. Clients that send the parameter lose its effect. |
| Optional parameter became required | Breaking |
| Required parameter became optional | Compatible |
| `style`, `explode`, `allowReserved`, or the `content` media type changed | Breaking. The serialized form of the value changes. |
| `allowEmptyValue` removed | Breaking |
| `allowEmptyValue` added | Compatible |
| Schema changed | See the schema rules, with request direction. |
| Deprecated, description, or example changed | Compatible |

## Request body

| Change | Class |
| --- | --- |
| Required request body added | Breaking |
| Optional request body added | Compatible |
| Request body removed | Breaking |
| Optional request body became required | Breaking |
| Required request body became optional | Compatible |
| Media type removed | Breaking |
| Media type added | Compatible |
| Schema changed | See the schema rules, with request direction. |

## Responses

| Change | Class |
| --- | --- |
| Response with a status code below 400 removed | Breaking. Clients expect the success or redirect response. |
| Response with a 4XX, 5XX, or `default` status removed | Compatible |
| Response added | Compatible |
| Media type removed | Breaking |
| Media type added | Compatible. Clients select a media type with the `Accept` header. |
| Response header removed | Breaking |
| Response header added | Compatible |
| Response header became optional | Breaking |
| Response header became required | Compatible |
| Schema changed | See the schema rules, with response direction. |
| Description or summary changed | Compatible |

## Schemas

Schema rules depend on direction. The request column applies to request values. The response column applies to response values.

| Change | Request | Response |
| --- | --- | --- |
| Optional property added | Compatible | Compatible |
| Required property added | Breaking | Compatible |
| Property removed | Breaking | Breaking |
| Optional property became required | Breaking | Compatible |
| Required property became optional | Compatible | Breaking |
| Type changed to an unrelated type | Breaking | Breaking |
| Type widened (a type added, or `integer` to `number`) | Compatible | Breaking |
| Type narrowed (a type removed, or `number` to `integer`) | Breaking | Compatible |
| `null` allowed | Compatible | Breaking |
| `null` no longer allowed | Breaking | Compatible |
| Format added | Breaking | Compatible |
| Format removed | Compatible | Breaking |
| Format changed | Breaking | Breaking |
| Enum value added | Compatible | Breaking |
| Enum value removed | Breaking | Compatible |
| Enum added to a schema that had none | Breaking | Compatible |
| Enum removed | Compatible | Breaking |
| `const` added | Breaking | Compatible |
| `const` removed | Compatible | Breaking |
| `const` changed | Breaking | Breaking |
| Limit tightened | Breaking | Compatible |
| Limit loosened | Compatible | Breaking |
| Pattern added | Breaking | Compatible |
| Pattern removed | Compatible | Breaking |
| Pattern changed | Breaking | Breaking |
| Default value changed | Breaking | Compatible |
| Default value added or removed | Compatible | Compatible |
| `additionalProperties: false` added | Breaking | Compatible |
| `additionalProperties: false` removed | Compatible | Compatible |
| Schema added for `items`, `additionalProperties`, or a `patternProperties` entry | Breaking | Compatible |
| Schema removed for `items`, `additionalProperties`, or a `patternProperties` entry | Compatible | Breaking |
| `oneOf` or `anyOf` variant added | Compatible | Breaking |
| `oneOf` or `anyOf` variant removed | Breaking | Compatible |
| Discriminator property changed | Breaking | Breaking |
| Discriminator mapping added | Compatible | Breaking |
| Discriminator mapping removed | Breaking | Compatible |
| Discriminator mapping target changed | Breaking | Breaking |
| `not` schema changed | Breaking | Breaking |
| Schema name changed (the `$ref` target or `title`) | Compatible | Compatible |
| Description, example, or deprecation changed | Compatible | Compatible |

The rules apply at each level of a schema: properties, array items, `prefixItems` entries, additional properties, pattern properties, and variants. The tool merges `allOf` members into one schema before it compares, so a change inside an `allOf` member counts as a change of the merged schema. A `oneOf` or `anyOf` with a `{type: "null"}` member counts as a schema that allows `null`.

A limit is one of these keywords: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `minProperties`, `maxProperties`, `multipleOf`, and `uniqueItems`. A new limit counts as tightened. A removed limit counts as loosened. A change of `multipleOf` counts as loosened only when the new value divides the old value.

A `readOnly` property does not occur in requests, and a `writeOnly` property does not occur in responses. The tool leaves such properties out of the tree for that direction. Thus a property that becomes `readOnly` counts as a request property removal.

## Security

| Change | Class |
| --- | --- |
| Security added to an endpoint that had none | Breaking |
| All security removed from an endpoint | Compatible |
| Security alternative removed | Breaking |
| Security alternative added | Compatible |
| OAuth scope added to a requirement | Breaking |
| OAuth scope removed from a requirement | Compatible |
| Anonymous access (`{}`) added | Compatible |
| Anonymous access removed while other alternatives remain | Breaking |
| Security scheme definition changed (type, location, name, scheme) | Breaking |
| OAuth flow added | Compatible |
| OAuth flow removed | Breaking |
| OAuth flow URL changed, added, or removed | Breaking |
| Security scheme description or bearer format changed | Compatible |

A requirement that lists several schemes needs all of them. Thus a scheme added to a requirement shows as the old requirement removed and a new one added.

## Servers and document information

| Change | Class |
| --- | --- |
| Server URL removed | Breaking |
| Server URL added | Compatible |
| Title, version, or description changed | Compatible |

An operation without its own `servers` uses the document servers. The tool compares the servers that each operation uses.

The `openapi` version is not compared. The tool gives the same meaning to the same API in 3.0, 3.1, and 3.2, so a version upgrade alone shows no change.

## Webhooks and callbacks

Webhooks and callbacks use the endpoint, parameter, body, and schema rules with flipped directions. A removed webhook is breaking, because consumers stop receiving it. An added webhook is compatible.

## Not compared

The tool ignores these parts of a document:

- Specification extensions (`x-*` fields).
- XML objects.
- Links and encoding objects.
- Components that no endpoint uses.

## Known limits

- A new success status code (for example, `202` next to `200`) is compatible under these rules. A strict client that expects only `200` can still fail.
- The tool cannot compare two regular expressions for subset relations. Thus each pattern change counts as breaking.
