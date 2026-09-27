/**
 * Schema Objects to view nodes.
 *
 * A schema that only refers to another one (`$ref: Pet`, maybe nullable)
 * becomes a node with a `ref` to a shared definition. The builder makes each
 * definition once per schema and direction, the first time a node needs it.
 * A reference cycle simply points back to a definition that is under
 * construction, so cycles need no special case.
 *
 * Any other schema is built in place. It first becomes a {@link FlatSchema}:
 * the schema and all its `allOf` members merged into one set of keywords.
 * Each nested schema keeps its file and JSON pointer, because a nested `$ref`
 * resolves against the file it appears in, and a UI can jump to it. Then its
 * properties, items, and variants become child nodes: again references, or
 * built in place.
 */
import type { DocumentStore, Resolved } from '../load/documents.ts';
import { appendPointer } from '../load/json-pointer.ts';
import type { OasFamily } from '../load/version.ts';
import { upgradeSchema30 } from '../oas/shim30.ts';
import { asObject, compact, getArray, getNumber, getString, getStringArray, getText } from '../util.ts';
import { effectiveAttrs, sortTypes } from './tree.ts';
import type { Attrs, Direction, JsonValue, NodeKind, ViewNode } from './tree.ts';

/** A raw schema (or reference), with the file and the JSON pointer where it appears. */
export interface Located {
    raw: unknown;
    file: string;
    pointer: string;
}

export interface BuildContext {
    store: DocumentStore;
    /** The file of the OpenAPI document that is being built. */
    rootFile: string;
    family: OasFamily;
    /** Collects problems that do not stop the build. A Set, so each problem shows once. */
    warnings: Set<string>;
    /** Schema definitions by id. A definition under construction is already here, so a cycle finds it. */
    schemas: Map<string, ViewNode>;
}

export interface SchemaScope {
    direction: Direction;
    /** Nesting depth of schemas built in place, a guard against cycles made of YAML aliases. */
    depth: number;
}

/** A schema with its `allOf` members merged. */
interface FlatSchema {
    /** Keywords where the first definition wins (outer schema before `allOf` members). */
    keywords: Record<string, unknown>;
    types?: Set<string>;
    /** Null is allowed on top of `types`, from a `oneOf`/`anyOf` member `{type: 'null'}`. */
    nullable?: boolean;
    enumValues?: unknown[];
    required: Set<string>;
    properties: Map<string, Located[]>;
    patternProperties: Map<string, Located[]>;
    /** `false` when some member forbids additional properties. */
    additionalProperties: Located[] | false;
    items: Located[];
    prefixItems: Located[][];
    composition?: { kind: 'oneOf' | 'anyOf'; members: Located[] };
    not: Located[];
    /** Name of the first `$ref` target merged in. */
    name?: string;
    /** Identities of the `$ref` targets merged into this schema. A second visit adds nothing. */
    keys: Set<string>;
    unresolved?: string;
}

/** Keywords where the outer schema wins over `allOf` members. */
const FIRST_WINS = [
    'title',
    'description',
    'format',
    'default',
    'const',
    'example',
    'examples',
    'pattern',
    'multipleOf',
    'contentMediaType',
    'contentEncoding',
    'discriminator',
] as const;
/** Lower limits: `allOf` members combine to the largest. */
const LOWER_LIMITS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'] as const;
/** Upper limits: `allOf` members combine to the smallest. */
const UPPER_LIMITS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'] as const;
/** Flags: `allOf` members combine with OR. */
const FLAGS = ['uniqueItems', 'readOnly', 'writeOnly', 'deprecated'] as const;
/** Keywords next to a `$ref` that document the use, but leave the schema as it is. */
const DOC_KEYWORDS = new Set(['description', 'summary', 'title', 'example', 'examples', 'deprecated', 'externalDocs', 'xml']);

const MAX_DEPTH = 64;

export function located(raw: unknown, file: string, pointer: string): Located {
    return { raw, file, pointer };
}

// --- Nodes ------------------------------------------------------------------

/**
 * Build a node for a schema. `locs` holds the schema, or several schemas that
 * combine like an `allOf`. `ownAttrs` come from the object that holds the
 * schema (a parameter, a header, a property) and win over the schema facts.
 */
export function schemaNode(
    kind: NodeKind,
    key: string,
    label: string,
    locs: Located[],
    scope: SchemaScope,
    ctx: BuildContext,
    ownAttrs: Attrs = {},
): ViewNode {
    const source = locs.length > 0 ? { file: locs[0].file, pointer: locs[0].pointer } : undefined;
    const reference = locs.length === 1 ? asReference(locs[0], ctx) : undefined;
    if (reference !== undefined) {
        const target = ctx.store.deref(reference.raw, reference.file);
        if (target.unresolved === undefined) {
            const attrs = compact<Attrs>({ ...reference.docs, nullable: reference.nullable ? (true as const) : undefined, ...compact(ownAttrs) });
            return { kind, key, label, direction: scope.direction, attrs, children: [], ref: definition(target, scope.direction, ctx), source };
        }
    }
    const flat = flatten(locs, ctx);
    const node: ViewNode = { kind, key, label, direction: scope.direction, attrs: { ...schemaAttrs(flat), ...compact(ownAttrs) }, children: [], source };
    schemaChildren(node, flat, scope, ctx);
    return node;
}

/**
 * The id of the definition of a `$ref` target for one direction, built on
 * first use. The node goes into the table before its children are built, so a
 * reference cycle finds it.
 */
function definition(target: Resolved, direction: Direction, ctx: BuildContext): string {
    const id = `${direction} ${target.key}`;
    if (!ctx.schemas.has(id)) {
        const flat = flatten([located(target.value, target.file, target.pointer ?? '#')], ctx, target);
        const node: ViewNode = {
            kind: 'schema',
            key: id,
            label: target.name ?? id,
            direction,
            attrs: schemaAttrs(flat),
            children: [],
            source: { file: target.file, pointer: target.pointer ?? '#' },
        };
        ctx.schemas.set(id, node);
        schemaChildren(node, flat, { direction, depth: 0 }, ctx);
    }
    return id;
}

/** A schema that only refers to another one, with the documentation keywords of the use. */
interface Reference {
    /** The `$ref` object. */
    raw: unknown;
    file: string;
    /** Documentation facts of the use, for example a description next to the `$ref`. */
    docs: Attrs;
    nullable: boolean;
}

/**
 * The reference that a schema stands for: `{$ref}` with at most
 * documentation keywords next to it, a one-member `allOf` around such a
 * reference, or such a reference with a `{type: 'null'}` alternative (the 3.1
 * form of a nullable reference). `undefined` for any other schema.
 */
function asReference(loc: Located, ctx: BuildContext): Reference | undefined {
    const schema = asObject(loc.raw);
    if (schema === undefined) {
        return undefined;
    }
    if (typeof schema.$ref === 'string') {
        // 3.0 documents often write `nullable: true` next to a `$ref`. In 3.1, `nullable` is not a keyword.
        const rest = { ...schema };
        delete rest.$ref;
        delete rest.nullable;
        const nullable = ctx.family === '3.0' && schema.nullable === true;
        return onlyDocs(rest) ? { raw: loc.raw, file: loc.file, docs: docAttrs(rest), nullable } : undefined;
    }
    const s = ctx.family === '3.0' ? upgradeSchema30(schema) : schema;
    const { allOf, oneOf, anyOf, ...rest } = s;
    if (!onlyDocs(rest) || [allOf, oneOf, anyOf].filter((list) => list !== undefined).length !== 1) {
        return undefined;
    }
    const wrap = (inner: Reference | undefined, nullable: boolean): Reference | undefined =>
        inner === undefined ? undefined : { ...inner, docs: { ...inner.docs, ...docAttrs(rest) }, nullable: inner.nullable || nullable };
    const allOfMembers = getArray(allOf);
    if (allOfMembers.length === 1) {
        return wrap(asReference(located(allOfMembers[0], loc.file, loc.pointer), ctx), false);
    }
    const members = getArray(oneOf ?? anyOf);
    const others = members.filter((member) => !isNullSchema(member));
    if (members.length === 2 && others.length === 1) {
        return wrap(asReference(located(others[0], loc.file, loc.pointer), ctx), true);
    }
    return undefined;
}

function onlyDocs(keywords: Record<string, unknown>): boolean {
    return Object.keys(keywords).every((key) => DOC_KEYWORDS.has(key) || key.startsWith('x-'));
}

function docAttrs(keywords: Record<string, unknown>): Attrs {
    return compact({
        title: getText(keywords.title),
        description: getText(keywords.description) ?? getText(keywords.summary),
        deprecated: keywords.deprecated === true ? true : undefined,
        example: (keywords.example ?? getArray(keywords.examples)[0]) as JsonValue | undefined,
    });
}

/** Add the child nodes of a schema (properties, items, variants) to `node`. */
function schemaChildren(node: ViewNode, flat: FlatSchema, scope: SchemaScope, ctx: BuildContext): void {
    if (scope.depth >= MAX_DEPTH) {
        ctx.warnings.add(`A schema nests deeper than ${MAX_DEPTH} levels. The deeper levels are not shown.`);
        return;
    }
    const inner: SchemaScope = { direction: scope.direction, depth: scope.depth + 1 };
    const children = node.children;

    // A readOnly property does not occur in requests, and a writeOnly property does not occur in responses.
    const hidden = scope.direction === 'request' ? 'readOnly' : 'writeOnly';
    for (const [name, locs] of flat.properties) {
        // Checked on the merged keywords first, so a hidden property builds no definitions.
        if (flatten(locs, ctx).keywords[hidden] === true) {
            node.omitted = { ...node.omitted, [name]: hidden };
            continue;
        }
        const own: Attrs = flat.required.has(name) ? { required: true } : {};
        children.push(schemaNode('property', name, name, locs, inner, ctx, own));
    }
    for (const [pattern, locs] of flat.patternProperties) {
        children.push(schemaNode('patternProperty', `/${pattern}/`, `/${pattern}/`, locs, inner, ctx));
    }
    if (flat.additionalProperties !== false && flat.additionalProperties.length > 0) {
        children.push(schemaNode('additionalProperties', '*', 'additional properties', flat.additionalProperties, inner, ctx));
    }
    flat.prefixItems.forEach((locs, i) => {
        children.push(schemaNode('items', `[${i}]`, `[${i}]`, locs, inner, ctx));
    });
    if (flat.items.length > 0) {
        children.push(schemaNode('items', '[]', 'items', flat.items, inner, ctx));
    }
    if (flat.composition !== undefined) {
        children.push(...variantNodes(flat.composition.members, inner, ctx));
    }
    if (flat.not.length > 0) {
        children.push(schemaNode('not', 'not', 'not', flat.not, inner, ctx));
    }
}

/**
 * Nodes for `oneOf`/`anyOf` members. The key must survive the insertion of a
 * new member, so it is the schema name when unique, else the type when
 * unique, else the position.
 */
function variantNodes(members: Located[], scope: SchemaScope, ctx: BuildContext): ViewNode[] {
    const nodes = members.map((member) => schemaNode('variant', '', '', [member], scope, ctx));
    const facts = nodes.map((node) => effectiveAttrs(node, (id) => ctx.schemas.get(id)));
    const names = facts.map((attrs) => attrs.title);
    const types = facts.map((attrs) => attrs.type?.join(' | '));
    const isUnique = (value: string | undefined, all: (string | undefined)[]) =>
        value !== undefined && all.filter((v) => v === value).length === 1;
    return nodes.map((node, i) => {
        const named = isUnique(names[i], names) ? names[i] : isUnique(types[i], types) ? types[i] : undefined;
        return { ...node, key: named ?? `#${i + 1}`, label: named ?? `option ${i + 1}` };
    });
}

// --- Flattening -------------------------------------------------------------

/**
 * Merge located schemas (an implicit `allOf`) into one flat schema.
 * `identity` is the `$ref` target that the schema defines, if any: it counts
 * as merged already, so an `allOf` that refers back to it adds nothing.
 */
function flatten(locs: Located[], ctx: BuildContext, identity?: Resolved): FlatSchema {
    const flat: FlatSchema = {
        keywords: {},
        required: new Set(),
        properties: new Map(),
        patternProperties: new Map(),
        additionalProperties: [],
        items: [],
        prefixItems: [],
        not: [],
        keys: new Set(identity?.key === undefined ? [] : [identity.key]),
        name: identity?.name,
    };
    for (const loc of locs) {
        collect(loc, flat, ctx);
    }
    return flat;
}

function collect(loc: Located, flat: FlatSchema, ctx: BuildContext): void {
    const target = ctx.store.deref(loc.raw, loc.file);
    if (target.unresolved !== undefined) {
        flat.unresolved ??= target.unresolved;
        ctx.warnings.add(`Unresolved $ref "${target.unresolved}" in ${ctx.store.display(loc.file)}${target.reason ? ` (${target.reason})` : ''}`);
        return;
    }
    let pointer = loc.pointer;
    if (target.key !== undefined) {
        if (flat.keys.has(target.key)) {
            return; // The same schema twice in one allOf chain adds nothing.
        }
        flat.keys.add(target.key);
        flat.name ??= target.name;
        // Keywords next to a `$ref` override the target (3.1 semantics). Many 3.0
        // documents also put a description there, so both versions honor it.
        const siblings = { ...asObject(loc.raw) };
        delete siblings.$ref;
        if (Object.keys(siblings).length > 0) {
            merge(siblings, loc.file, loc.pointer, flat, ctx);
        }
        pointer = target.pointer ?? '#';
    }
    if (target.value === false) {
        // The boolean schema `false` allows no value at all.
        merge({ not: {} }, target.file, pointer, flat, ctx);
    }
    const schema = asObject(target.value);
    if (schema !== undefined) {
        merge(schema, target.file, pointer, flat, ctx);
    }
}

function merge(raw: Record<string, unknown>, file: string, pointer: string, flat: FlatSchema, ctx: BuildContext): void {
    const s = ctx.family === '3.0' ? upgradeSchema30(raw) : raw;
    const kw = flat.keywords;

    for (const key of FIRST_WINS) {
        if (kw[key] === undefined && s[key] !== undefined) {
            kw[key] = s[key];
        }
    }
    for (const key of LOWER_LIMITS) {
        const value = getNumber(s[key]);
        if (value !== undefined) {
            kw[key] = Math.max(value, getNumber(kw[key]) ?? -Infinity);
        }
    }
    for (const key of UPPER_LIMITS) {
        const value = getNumber(s[key]);
        if (value !== undefined) {
            kw[key] = Math.min(value, getNumber(kw[key]) ?? Infinity);
        }
    }
    for (const key of FLAGS) {
        if (s[key] === true) {
            kw[key] = true;
        }
    }

    const types = schemaTypes(s.type);
    if (types !== undefined) {
        flat.types = flat.types === undefined ? types : intersectTypes(flat.types, types);
    }
    if (Array.isArray(s.enum)) {
        const values = s.enum;
        flat.enumValues = flat.enumValues === undefined ? values : flat.enumValues.filter((v) => values.some((w) => w === v));
    }
    for (const name of getStringArray(s.required)) {
        flat.required.add(name);
    }

    const at = (value: unknown, ...parts: (string | number)[]): Located => located(value, file, appendPointer(pointer, ...parts));
    // `unevaluatedProperties` is the 3.1 way to close an object that `allOf` builds.
    for (const keyword of ['additionalProperties', 'unevaluatedProperties'] as const) {
        const extra = s[keyword];
        if (extra === false) {
            flat.additionalProperties = false;
        } else if (isRestrictingSchema(extra) && flat.additionalProperties !== false) {
            flat.additionalProperties.push(at(extra, keyword));
        }
    }
    if (isRestrictingSchema(s.items) || s.items === false) {
        flat.items.push(at(s.items, 'items'));
    }
    getArray(s.prefixItems).forEach((item, i) => (flat.prefixItems[i] ??= []).push(at(item, 'prefixItems', i)));
    for (const kind of ['oneOf', 'anyOf'] as const) {
        // `oneOf: [X, {type: 'null'}]` means "X or null". Show it as X with a "null" type.
        const members = getArray(s[kind]).map((member, i) => at(member, kind, i));
        const others = members.filter((member) => !isNullSchema(member.raw));
        if (others.length < members.length) {
            flat.nullable = true;
        }
        if (others.length === 1) {
            collect(others[0], flat, ctx);
        } else if (others.length > 1) {
            if (flat.composition === undefined) {
                flat.composition = { kind, members: others };
            } else {
                ctx.warnings.add(`A schema in ${ctx.store.display(file)} combines several oneOf/anyOf lists. Only the first one is compared.`);
            }
        }
    }
    if (asObject(s.not) !== undefined) {
        flat.not.push(at(s.not, 'not'));
    }
    // Members first, so inherited properties show before the schema's own ones.
    getArray(s.allOf).forEach((member, i) => collect(at(member, 'allOf', i), flat, ctx));
    for (const [name, prop] of Object.entries(asObject(s.properties) ?? {})) {
        appendTo(flat.properties, name, at(prop, 'properties', name));
    }
    for (const [pattern, prop] of Object.entries(asObject(s.patternProperties) ?? {})) {
        appendTo(flat.patternProperties, pattern, at(prop, 'patternProperties', pattern));
    }
}

/** The facts of a flat schema as node attributes. */
function schemaAttrs(flat: FlatSchema): Attrs {
    const kw = flat.keywords;
    const attrs: Attrs = {};
    const set = <K extends keyof Attrs>(key: K, value: Attrs[K] | undefined) => {
        if (value !== undefined) {
            attrs[key] = value;
        }
    };
    const types = inferTypes(flat);
    set('title', getText(kw.title) ?? flat.name);
    set('type', types);
    // Without a known type, "null allowed" needs its own fact.
    set('nullable', types === undefined && flat.nullable ? true : undefined);
    set('format', getString(kw.format));
    set('description', getText(kw.description));
    set('deprecated', kw.deprecated === true ? true : undefined);
    set('readOnly', kw.readOnly === true ? true : undefined);
    set('writeOnly', kw.writeOnly === true ? true : undefined);
    set('enum', flat.enumValues as JsonValue[] | undefined);
    set('const', kw.const as JsonValue | undefined);
    set('default', kw.default as JsonValue | undefined);
    set('example', (kw.example ?? getArray(kw.examples)[0]) as JsonValue | undefined);
    for (const key of [...LOWER_LIMITS, ...UPPER_LIMITS, 'multipleOf'] as const) {
        set(key, getNumber(kw[key]));
    }
    set('uniqueItems', kw.uniqueItems === true ? true : undefined);
    set('pattern', getString(kw.pattern));
    set('contentMediaType', getString(kw.contentMediaType));
    set('contentEncoding', getString(kw.contentEncoding));
    set('additionalProperties', flat.additionalProperties === false ? false : undefined);
    set('composition', flat.composition?.kind);
    const discriminator = asObject(kw.discriminator);
    set('discriminator', getString(discriminator?.propertyName));
    const mapping = asObject(discriminator?.mapping);
    if (mapping !== undefined) {
        set('mapping', Object.fromEntries(Object.entries(mapping).map(([value, ref]) => [value, refName(String(ref))])));
    }
    const defaultMapping = getString(discriminator?.defaultMapping);
    set('defaultMapping', defaultMapping === undefined ? undefined : refName(defaultMapping));
    set('unresolved', flat.unresolved);
    return attrs;
}

/** A schema object that restricts values. `{}` and `true` allow everything. */
function isRestrictingSchema(value: unknown): boolean {
    const schema = asObject(value);
    return schema !== undefined && Object.keys(schema).length > 0;
}

function schemaTypes(type: unknown): Set<string> | undefined {
    if (typeof type === 'string') {
        return new Set([type]);
    }
    const list = getStringArray(type);
    return list.length > 0 ? new Set(list) : undefined;
}

/** Types allowed by both sets. `integer` is a subset of `number`. */
function intersectTypes(a: Set<string>, b: Set<string>): Set<string> {
    const out = new Set<string>();
    for (const type of a) {
        if (b.has(type)) {
            out.add(type);
        } else if ((type === 'integer' && b.has('number')) || (type === 'number' && b.has('integer'))) {
            out.add('integer');
        }
    }
    return out;
}

/** The declared types in canonical order, or else the type implied by the keywords present. */
function inferTypes(flat: FlatSchema): string[] | undefined {
    let types = flat.types;
    if (types === undefined) {
        if (flat.properties.size > 0 || flat.patternProperties.size > 0 || (flat.additionalProperties !== false && flat.additionalProperties.length > 0)) {
            types = new Set(['object']);
        } else if (flat.items.length > 0 || flat.prefixItems.length > 0) {
            types = new Set(['array']);
        } else {
            return undefined;
        }
    }
    return sortTypes(flat.nullable ? [...types, 'null'] : [...types]);
}

/** `{type: 'null'}`, with at most a title or description. */
function isNullSchema(raw: unknown): boolean {
    const schema = asObject(raw);
    if (schema === undefined) {
        return false;
    }
    const type = Array.isArray(schema.type) && schema.type.length === 1 ? schema.type[0] : schema.type;
    return type === 'null' && Object.keys(schema).every((key) => ['type', 'title', 'description'].includes(key));
}

function appendTo<K>(map: Map<K, Located[]>, key: K, loc: Located): void {
    const list = map.get(key);
    if (list) {
        list.push(loc);
    } else {
        map.set(key, [loc]);
    }
}

/** The last segment of a reference: `Cat` for `#/components/schemas/Cat`. A plain name stays as it is. */
function refName(ref: string): string {
    return ref.slice(ref.lastIndexOf('/') + 1);
}
