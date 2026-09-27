/**
 * Schema Objects to view nodes.
 *
 * A schema first becomes a {@link FlatSchema}: the schema, its `$ref` target,
 * and all its `allOf` members merged into one set of keywords. The merge keeps
 * the source file of each nested schema, because a nested `$ref` resolves
 * against the file it appears in. Then the flat schema becomes a node, and its
 * properties, items, and variants become child nodes.
 *
 * Recursion: each nested schema remembers the `$ref` targets whose content
 * holds it (`Located.enclosing`). A reference to one of them is a cycle, and
 * the node stops there with a `recursive` marker. A schema that only reuses a
 * target of its parent's `allOf` is not a cycle, so it expands normally.
 */
import type { DocumentStore } from '../load/documents.ts';
import type { OasFamily } from '../load/version.ts';
import { upgradeSchema30 } from '../oas/shim30.ts';
import { asObject, getArray, getNumber, getString, getStringArray, getText } from '../util.ts';
import type { Attrs, Direction, JsonValue, NodeKind, ViewNode } from './tree.ts';

/** A raw schema (or reference), the file it appears in, and the `$ref` targets whose content holds it. */
export interface Located {
    raw: unknown;
    file: string;
    enclosing: ReadonlySet<string>;
}

export interface BuildContext {
    store: DocumentStore;
    /** The file of the OpenAPI document that is being built. */
    rootFile: string;
    family: OasFamily;
    /** Collects problems that do not stop the build. A Set, so each problem shows once. */
    warnings: Set<string>;
}

export interface SchemaScope {
    direction: Direction;
    /** Nesting depth, a guard against cycles made of YAML aliases instead of `$ref`s. */
    depth: number;
}

/** A schema with its `$ref`, `$ref` siblings, and `allOf` members merged. */
export interface FlatSchema {
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
    /** Name of the first `$ref` target. */
    name?: string;
    /** Identities of the `$ref` targets merged into this schema. */
    keys: Set<string>;
    /** Set when the schema is only a reference back to an enclosing schema. */
    recursive?: string;
    /** A reference back to an enclosing schema, found inside an `allOf` or a null alternative. */
    recursiveHit?: string;
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

const TYPE_ORDER = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];
const MAX_DEPTH = 64;
const NOTHING: ReadonlySet<string> = new Set();

/** A schema at the top of a tree (a parameter, a body): no enclosing `$ref` targets yet. */
export function topLevel(raw: unknown, file: string): Located {
    return { raw, file, enclosing: NOTHING };
}

/** Merge located schemas (an implicit `allOf`) into one flat schema. */
export function flatten(locs: Located[], ctx: BuildContext): FlatSchema {
    const flat: FlatSchema = {
        keywords: {},
        required: new Set(),
        properties: new Map(),
        patternProperties: new Map(),
        additionalProperties: [],
        items: [],
        prefixItems: [],
        not: [],
        keys: new Set(),
    };
    locs.forEach((loc, i) => collect(loc, flat, ctx, i === 0));
    if (flat.recursive === undefined && flat.recursiveHit !== undefined && hasNoContent(flat)) {
        flat.recursive = flat.recursiveHit;
    }
    return flat;
}

function collect(loc: Located, flat: FlatSchema, ctx: BuildContext, isTop: boolean): void {
    const target = ctx.store.deref(loc.raw, loc.file);
    if (target.unresolved !== undefined) {
        flat.unresolved ??= target.unresolved;
        ctx.warnings.add(`Unresolved $ref "${target.unresolved}" in ${loc.file}${target.reason ? ` (${target.reason})` : ''}`);
        return;
    }
    let enclosing = loc.enclosing;
    if (target.key !== undefined) {
        if (enclosing.has(target.key)) {
            if (isTop) {
                flat.recursive = target.name;
            } else {
                flat.recursiveHit ??= target.name;
            }
            return;
        }
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
            merge(siblings, loc.file, enclosing, flat, ctx);
        }
        enclosing = new Set([...enclosing, target.key]);
    }
    if (target.value === false) {
        // The boolean schema `false` allows no value at all.
        merge({ not: {} }, target.file, enclosing, flat, ctx);
    }
    const schema = asObject(target.value);
    if (schema !== undefined) {
        merge(schema, target.file, enclosing, flat, ctx);
    }
}

function merge(raw: Record<string, unknown>, file: string, enclosing: ReadonlySet<string>, flat: FlatSchema, ctx: BuildContext): void {
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

    const at = (raw: unknown): Located => ({ raw, file, enclosing });
    // `unevaluatedProperties` is the 3.1 way to close an object that `allOf` builds.
    for (const extra of [s.additionalProperties, s.unevaluatedProperties]) {
        if (extra === false) {
            flat.additionalProperties = false;
        } else if (isRestrictingSchema(extra) && flat.additionalProperties !== false) {
            flat.additionalProperties.push(at(extra));
        }
    }
    if (isRestrictingSchema(s.items) || s.items === false) {
        flat.items.push(at(s.items));
    }
    getArray(s.prefixItems).forEach((item, i) => (flat.prefixItems[i] ??= []).push(at(item)));
    for (const kind of ['oneOf', 'anyOf'] as const) {
        // `oneOf: [X, {type: 'null'}]` means "X or null". Show it as X with a "null" type.
        const members = getArray(s[kind]);
        const others = members.filter((member) => !isNullSchema(member));
        if (others.length < members.length) {
            flat.nullable = true;
        }
        if (others.length === 1) {
            collect(at(others[0]), flat, ctx, false);
        } else if (others.length > 1) {
            if (flat.composition === undefined) {
                flat.composition = { kind, members: others.map(at) };
            } else {
                ctx.warnings.add(`A schema in ${file} combines several oneOf/anyOf lists. Only the first one is compared.`);
            }
        }
    }
    if (asObject(s.not) !== undefined) {
        flat.not.push(at(s.not));
    }
    // Members first, so inherited properties show before the schema's own ones.
    for (const member of getArray(s.allOf)) {
        collect(at(member), flat, ctx, false);
    }
    for (const [name, prop] of Object.entries(asObject(s.properties) ?? {})) {
        appendTo(flat.properties, name, at(prop));
    }
    for (const [pattern, prop] of Object.entries(asObject(s.patternProperties) ?? {})) {
        appendTo(flat.patternProperties, pattern, at(prop));
    }
}

/** The facts of a flat schema as node attributes. */
export function schemaAttrs(flat: FlatSchema): Attrs {
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
    set('recursive', flat.recursive);
    set('unresolved', flat.unresolved);
    return attrs;
}

/**
 * Build a node for a schema. `ownAttrs` come from the object that holds the
 * schema (a parameter, a header, a property) and win over the schema facts.
 */
export function schemaNode(
    kind: NodeKind,
    key: string,
    label: string,
    flat: FlatSchema,
    scope: SchemaScope,
    ctx: BuildContext,
    ownAttrs: Attrs = {},
): ViewNode {
    const attrs: Attrs = { ...ownAttrs };
    for (const [name, value] of Object.entries(schemaAttrs(flat))) {
        if ((attrs as Record<string, unknown>)[name] === undefined) {
            (attrs as Record<string, unknown>)[name] = value;
        }
    }
    const children = flat.recursive === undefined ? schemaChildren(flat, scope, ctx) : [];
    return { kind, key, label, direction: scope.direction, attrs, children };
}

/** Build a node for located schemas in one step. */
export function buildSchemaNode(
    kind: NodeKind,
    key: string,
    label: string,
    locs: Located[],
    scope: SchemaScope,
    ctx: BuildContext,
    ownAttrs: Attrs = {},
): ViewNode {
    return schemaNode(kind, key, label, flatten(locs, ctx), scope, ctx, ownAttrs);
}

function schemaChildren(flat: FlatSchema, scope: SchemaScope, ctx: BuildContext): ViewNode[] {
    if (scope.depth >= MAX_DEPTH) {
        ctx.warnings.add(`A schema nests deeper than ${MAX_DEPTH} levels. The deeper levels are not shown.`);
        return [];
    }
    const inner: SchemaScope = { direction: scope.direction, depth: scope.depth + 1 };
    const children: ViewNode[] = [];

    for (const [name, locs] of flat.properties) {
        const prop = flatten(locs, ctx);
        // A readOnly property does not occur in requests, and a writeOnly property does not occur in responses.
        if (prop.keywords[scope.direction === 'request' ? 'readOnly' : 'writeOnly'] === true) {
            continue;
        }
        const own: Attrs = flat.required.has(name) ? { required: true } : {};
        children.push(schemaNode('property', name, name, prop, inner, ctx, own));
    }
    for (const [pattern, locs] of flat.patternProperties) {
        children.push(buildSchemaNode('patternProperty', `/${pattern}/`, `/${pattern}/`, locs, inner, ctx));
    }
    if (flat.additionalProperties !== false && flat.additionalProperties.length > 0) {
        children.push(buildSchemaNode('additionalProperties', '*', 'additional properties', flat.additionalProperties, inner, ctx));
    }
    flat.prefixItems.forEach((locs, i) => {
        children.push(buildSchemaNode('items', `[${i}]`, `[${i}]`, locs, inner, ctx));
    });
    if (flat.items.length > 0) {
        children.push(buildSchemaNode('items', '[]', 'items', flat.items, inner, ctx));
    }
    if (flat.composition !== undefined) {
        children.push(...variantNodes(flat.composition.members, inner, ctx));
    }
    if (flat.not.length > 0) {
        children.push(buildSchemaNode('not', 'not', 'not', flat.not, inner, ctx));
    }
    return children;
}

/**
 * Nodes for `oneOf`/`anyOf` members. The key must survive the insertion of a
 * new member, so it is the schema name when unique, else the type when
 * unique, else the position.
 */
function variantNodes(members: Located[], scope: SchemaScope, ctx: BuildContext): ViewNode[] {
    const flats = members.map((member) => flatten([member], ctx));
    const names = flats.map((flat) => getText(flat.keywords.title) ?? flat.name ?? flat.recursive);
    const types = flats.map((flat) => inferTypes(flat)?.join(' | '));
    const isUnique = (value: string | undefined, all: (string | undefined)[]) =>
        value !== undefined && all.filter((v) => v === value).length === 1;
    return flats.map((flat, i) => {
        const key = isUnique(names[i], names) ? names[i]! : isUnique(types[i], types) ? types[i]! : `#${i + 1}`;
        return schemaNode('variant', key, key, flat, scope, ctx);
    });
}

/** The schema carries its own facts, apart from references to enclosing schemas. */
function hasNoContent(flat: FlatSchema): boolean {
    return (
        flat.types === undefined &&
        flat.enumValues === undefined &&
        flat.properties.size === 0 &&
        flat.patternProperties.size === 0 &&
        flat.additionalProperties !== false &&
        flat.additionalProperties.length === 0 &&
        flat.items.length === 0 &&
        flat.prefixItems.length === 0 &&
        flat.composition === undefined &&
        flat.not.length === 0
    );
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
    if (flat.nullable) {
        types = new Set([...types, 'null']);
    }
    return [...types].sort((a, b) => typeRank(a) - typeRank(b));
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

function typeRank(type: string): number {
    const rank = TYPE_ORDER.indexOf(type);
    return rank === -1 ? TYPE_ORDER.length : rank;
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
