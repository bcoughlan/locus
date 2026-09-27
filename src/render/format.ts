/**
 * Presentation helpers shared by all renderers: type labels, constraint
 * badges, and value formatting. They return plain text, so the console
 * renderer and a future HTML renderer describe facts the same way.
 */
import { maxSeverity } from '../diff/report.ts';
import type { AttrChange, ChangeStatus, DiffNode, Severity } from '../diff/report.ts';
import { effectiveAttrs } from '../model/tree.ts';
import type { AttrName, Attrs, JsonValue } from '../model/tree.ts';
import { defaultExplode, defaultStyle } from '../oas/serialization.ts';
import { canonicalJson, jsonDifference } from '../util.ts';

/** Looks up a definition diff by id: the `schemas` table of one document diff. */
export type Definitions = (id: string) => DiffNode | undefined;

/**
 * A node as a renderer shows it. A node with `ref` shows its definition: the
 * definition's facts under its own, the changes of both, and the definition's
 * children. The status and severity cover both, so a use site shows `~` when
 * the schema it refers to changed.
 */
export interface Shown {
    node: DiffNode;
    attrs: Attrs;
    changes: AttrChange[];
    children: DiffNode[];
    status: ChangeStatus;
    severity?: Severity;
}

export function show(node: DiffNode, definitions: Definitions): Shown {
    const definition = node.ref === undefined ? undefined : definitions(node.ref);
    if (definition === undefined) {
        return { node, attrs: node.attrs, changes: node.changes, children: node.children, status: node.status, severity: node.verdict?.severity };
    }
    // The use site's own facts (for example its own description) hide the definition's.
    const hidden = new Set<string>([...Object.keys(node.attrs), ...node.changes.map((change) => change.name)]);
    const paired = node.status === 'unchanged' || node.status === 'changed';
    const inherited = paired ? definition.changes.filter((change) => !hidden.has(change.name)) : [];
    return {
        node,
        attrs: effectiveAttrs(node, definitions),
        changes: [...node.changes, ...inherited],
        children: [...definition.children, ...node.children],
        status: node.status === 'unchanged' && inherited.length > 0 ? 'changed' : node.status,
        severity: inherited.reduce((max, change) => maxSeverity(max, change.severity), node.verdict?.severity),
    };
}

/**
 * For each definition diff, the number of references to the nearest change.
 * 0: the definition or one of its inline schemas changed. Definitions with no
 * change in reach have no entry. A large endpoint follows only the references
 * that get closer to a change: the shortest paths.
 */
export function changeDistances(schemas: Record<string, DiffNode>): Map<string, number> {
    const referrers = new Map<string, string[]>();
    const distances = new Map<string, number>();
    const queue: string[] = [];
    for (const [id, definition] of Object.entries(schemas)) {
        let changed = false;
        const visit = (node: DiffNode): void => {
            changed ||= node.status !== 'unchanged';
            if (node.ref !== undefined) {
                const list = referrers.get(node.ref);
                if (list === undefined) {
                    referrers.set(node.ref, [id]);
                } else {
                    list.push(id);
                }
            }
            node.children.forEach(visit);
        };
        visit(definition);
        if (changed) {
            distances.set(id, 0);
            queue.push(id);
        }
    }
    // Breadth-first from the changed definitions, backwards along the references.
    for (let i = 0; i < queue.length; i++) {
        const distance = distances.get(queue[i])! + 1;
        for (const referrer of referrers.get(queue[i]) ?? []) {
            if (!distances.has(referrer)) {
                distances.set(referrer, distance);
                queue.push(referrer);
            }
        }
    }
    return distances;
}

/** A value as short text: strings as they are, everything else as compact JSON. */
export function formatValue(value: unknown, maxLength = 80): string {
    const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * `string<email>`, `integer<int64> | null`, `array[Pet]`, `Pet`, `one of`.
 * `outer` holds the definitions of the enclosing labels: an array of itself
 * shows as `array[Tree]`.
 */
export function typeLabel(node: DiffNode, definitions: Definitions, outer: readonly string[] = []): string {
    const shown = show(node, definitions);
    const a = shown.attrs;
    if (node.ref !== undefined && outer.includes(node.ref)) {
        return a.title ?? '…';
    }
    if (a.unresolved !== undefined) {
        return `unresolved $ref ${a.unresolved}`;
    }
    const inner = node.ref === undefined ? outer : [...outer, node.ref];
    const types = a.type ?? [];
    const named = types.filter((type) => type !== 'null').map((type) => singleTypeLabel(type, shown, definitions, inner));
    const stream = shown.children.find((child) => child.kind === 'items' && child.key === 'itemSchema');
    if (named.length === 0) {
        if (a.composition !== undefined) {
            named.push(a.composition === 'oneOf' ? 'one of' : 'any of');
        } else if (a.const !== undefined) {
            named.push(a.const === null ? 'null' : Array.isArray(a.const) ? 'array' : typeof a.const);
        } else if (stream !== undefined) {
            named.push(`stream of ${typeLabel(stream, definitions, inner)}`);
        } else if (types.length === 0) {
            named.push('any');
        }
    }
    return types.includes('null') || a.nullable ? [...named, 'null'].join(' | ') : named.join(' | ');
}

function singleTypeLabel(type: string, shown: Shown, definitions: Definitions, outer: readonly string[]): string {
    const a = shown.attrs;
    if (type === 'array') {
        const items = arrayItems(shown.children);
        return `array[${items === undefined ? 'any' : typeLabel(items, definitions, outer)}]`;
    }
    if (type === 'object' && a.title !== undefined) {
        return a.title;
    }
    return a.format === undefined ? type : `${type}<${a.format}>`;
}

/** The `items` child of an array node, when it has one. */
export function arrayItems(children: DiffNode[]): DiffNode | undefined {
    return children.find((child) => child.kind === 'items' && child.key === '[]');
}

/**
 * The items node to print inside its array's row (`array[Pet]`, with the item
 * fields below), or `undefined` when the items need a row of their own: they
 * were added or removed while the array stayed.
 */
export function inlineItems(shown: Shown): DiffNode | undefined {
    const items = arrayItems(shown.children);
    return items !== undefined && (items.status === 'unchanged' || items.status === 'changed' || items.status === shown.node.status) ? items : undefined;
}

/** Short badges for the facts of a node, in display order. */
export function badges(attrs: Attrs): string[] {
    const out: string[] = [];
    /** A badge for a fact that is present. `false` is a value to show, not an absent fact. */
    const add = (value: unknown, text: string) => {
        if (value !== undefined) {
            out.push(text);
        }
    };
    const flag = (value: boolean | undefined, text: string) => {
        if (value === true) {
            out.push(text);
        }
    };
    flag(attrs.required, 'required');
    flag(attrs.deprecated, 'deprecated');
    flag(attrs.readOnly, 'read-only');
    flag(attrs.writeOnly, 'write-only');
    add(attrs.minimum, `>= ${attrs.minimum}`);
    add(attrs.exclusiveMinimum, `> ${attrs.exclusiveMinimum}`);
    add(attrs.maximum, `<= ${attrs.maximum}`);
    add(attrs.exclusiveMaximum, `< ${attrs.exclusiveMaximum}`);
    add(attrs.multipleOf, `multiple of ${attrs.multipleOf}`);
    out.push(...rangeBadges(attrs.minLength, attrs.maxLength, 'characters'));
    out.push(...rangeBadges(attrs.minItems, attrs.maxItems, 'items'));
    out.push(...rangeBadges(attrs.minProperties, attrs.maxProperties, 'properties'));
    flag(attrs.uniqueItems, 'unique items');
    add(attrs.pattern, `pattern ${attrs.pattern}`);
    add(attrs.contentMediaType, `media type ${attrs.contentMediaType}`);
    add(attrs.contentEncoding, `encoding ${attrs.contentEncoding}`);
    flag(attrs.additionalProperties === false, 'no additional properties');
    add(attrs.default, `default: ${formatValue(attrs.default)}`);
    // The model holds the effective style and explode. Show them when they differ from the defaults.
    if (attrs.style !== undefined && attrs.in !== undefined) {
        add(attrs.style === defaultStyle(attrs.in) ? undefined : attrs.style, `style: ${attrs.style}`);
        add(attrs.explode === defaultExplode(attrs.style) ? undefined : attrs.explode, `explode: ${attrs.explode}`);
    }
    flag(attrs.allowReserved, 'allow reserved');
    flag(attrs.allowEmptyValue, 'allow empty value');
    add(attrs.contentType, `content: ${attrs.contentType}`);
    return out;
}

function rangeBadges(min: number | undefined, max: number | undefined, unit: string): string[] {
    if (min !== undefined && min === max) {
        return [`${min} ${unit}`];
    }
    if (min === 1 && max === undefined && unit === 'characters') {
        return ['non-empty'];
    }
    return [...(min === undefined ? [] : [`>= ${min} ${unit}`]), ...(max === undefined ? [] : [`<= ${max} ${unit}`])];
}

/** Lines of detail below a row: allowed values, example, discriminator. The description is separate. */
export function details(attrs: Attrs): string[] {
    const out: string[] = [];
    if (attrs.enum !== undefined) {
        out.push(`Allowed values: ${attrs.enum.map((value) => formatValue(value)).join(', ')}`);
    }
    if (attrs.const !== undefined) {
        out.push(`Allowed value: ${formatValue(attrs.const)}`);
    }
    if (attrs.discriminator !== undefined) {
        const mapping = Object.entries(attrs.mapping ?? {}).map(([value, target]) => `${value} → ${target}`);
        out.push(`Discriminator: ${attrs.discriminator}${mapping.length > 0 ? ` (${mapping.join(', ')})` : ''}`);
    }
    if (attrs.example !== undefined) {
        out.push(`Example: ${formatValue(attrs.example)}`);
    }
    if (attrs.examples !== undefined) {
        out.push(`Examples: ${Object.keys(attrs.examples).join(', ')}`);
    }
    return out;
}

/** A security scheme in one line, for example `apiKey in header "X-API-Key"`. */
export function schemeLabel(attrs: Attrs): string {
    const parts: string[] = [];
    switch (attrs.schemeType) {
        case 'apiKey':
            parts.push(`apiKey in ${attrs.in ?? '?'} "${attrs.parameterName ?? '?'}"`);
            break;
        case 'http':
            parts.push(`http ${attrs.scheme ?? ''}${attrs.bearerFormat === undefined ? '' : ` (${attrs.bearerFormat})`}`.trim());
            break;
        case 'oauth2':
            parts.push(`oauth2${attrs.oauth2MetadataUrl === undefined ? '' : ` metadata ${attrs.oauth2MetadataUrl}`}`);
            break;
        case 'openIdConnect':
            parts.push(`openIdConnect ${attrs.openIdConnectUrl ?? ''}`.trim());
            break;
        case undefined:
            break;
        default:
            parts.push(attrs.schemeType);
    }
    if (attrs.unresolved !== undefined) {
        parts.push('undefined security scheme');
    }
    if (attrs.scopes !== undefined) {
        parts.push(`scopes: ${attrs.scopes.join(', ')}`);
    }
    return parts.join('  ');
}

/** The URLs of an OAuth flow in one line, for example `authorization: https://…  token: https://…`. */
export function flowLabel(attrs: Attrs): string {
    const urls: [string, string | undefined][] = [
        ['authorization', attrs.authorizationUrl],
        ['device authorization', attrs.deviceAuthorizationUrl],
        ['token', attrs.tokenUrl],
        ['refresh', attrs.refreshUrl],
    ];
    return urls.flatMap(([name, url]) => (url === undefined ? [] : [`${name}: ${url}`])).join('  ');
}

/**
 * A change of one attribute as text, for example `maximum: 500 → 100` or
 * `optional → required`. `prefix` names the part of the node, for example `items`.
 */
export function describeChange(change: AttrChange, prefix = ''): string {
    const name = `${prefix}${DISPLAY_NAMES[change.name] ?? change.name}`;
    const { before, after } = change;
    if (change.name === 'required') {
        return `${prefix}${before ? 'required' : 'optional'} → ${after ? 'required' : 'optional'}`;
    }
    if (change.name === 'examples') {
        return `${prefix}${describeExamples(before, after)}`;
    }
    if (LIST_ATTRS.has(change.name) && Array.isArray(before) && Array.isArray(after)) {
        // Only the values that changed: a long enum stays readable.
        const added = jsonDifference(after, before).map((value) => `+ ${formatValue(value, 40)}`);
        const removed = jsonDifference(before, after).map((value) => `- ${formatValue(value, 40)}`);
        return `${name}: ${[...added, ...removed].join(', ')}`;
    }
    if (FLAG_ATTRS.has(change.name)) {
        return `${name}: ${before === true} → ${after === true}`;
    }
    const separator = change.name === 'type' ? ' | ' : ', ';
    return `${name}: ${changeValue(before, separator)} → ${changeValue(after, separator)}`;
}

/** Attribute names that differ from the spec's field names. */
const DISPLAY_NAMES: Partial<Record<AttrName | 'name', string>> = {
    parameterName: 'name',
    schemeType: 'type',
    contentType: 'media type',
};
/** Boolean facts that the model stores only when true. Absent means false. */
const FLAG_ATTRS: ReadonlySet<AttrName | 'name'> = new Set(['deprecated', 'allowReserved', 'allowEmptyValue', 'readOnly', 'writeOnly', 'uniqueItems', 'nullable']);
/** Lists where a change shows as the values added and removed. */
const LIST_ATTRS: ReadonlySet<AttrName | 'name'> = new Set(['enum', 'tags', 'servers', 'scopes']);

/** An attribute value in a change line. An absent value shows as `(none)`. */
function changeValue(value: unknown, separator: string): string {
    if (value === undefined) {
        return '(none)';
    }
    if (Array.isArray(value)) {
        return value.map((item) => formatValue(item, 40)).join(separator);
    }
    return formatValue(value, 60);
}

/** Which named examples were added, removed, or changed, for example `example dog: value changed`. */
function describeExamples(before: unknown, after: unknown): string {
    const b = (before ?? {}) as Record<string, JsonValue>;
    const a = (after ?? {}) as Record<string, JsonValue>;
    const parts = [
        ...Object.keys(a).filter((name) => !(name in b)).map((name) => `example ${name} added`),
        ...Object.keys(b).filter((name) => !(name in a)).map((name) => `example ${name} removed`),
        ...Object.keys(a)
            .filter((name) => name in b && canonicalJson(a[name]) !== canonicalJson(b[name]))
            .map((name) => `example ${name}: value changed`),
    ];
    return parts.join('; ');
}
