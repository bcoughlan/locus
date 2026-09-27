/**
 * Presentation helpers shared by all renderers: type labels, constraint
 * badges, and value formatting. They return plain text, so the console
 * renderer and a future HTML renderer describe facts the same way.
 */
import type { AttrChange, DiffNode } from '../diff/report.ts';
import type { Attrs, JsonValue } from '../model/tree.ts';

/** A value as short text: strings as they are, everything else as compact JSON. */
export function formatValue(value: unknown, maxLength = 80): string {
    const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** `string<email>`, `integer<int64> | null`, `array[Pet]`, `Pet`, `one of`. */
export function typeLabel(node: Pick<DiffNode, 'attrs' | 'children'>): string {
    const a = node.attrs;
    if (a.recursive !== undefined) {
        return `${a.recursive} (recursive)${a.nullable ? ' | null' : ''}`;
    }
    if (a.truncated !== undefined) {
        return `${a.truncated} (not expanded)${a.nullable ? ' | null' : ''}`;
    }
    if (a.unresolved !== undefined) {
        return `unresolved $ref ${a.unresolved}`;
    }
    const types = a.type ?? [];
    const named = types.filter((type) => type !== 'null').map((type) => singleTypeLabel(type, node));
    const stream = node.children.find((child) => child.kind === 'items' && child.key === 'itemSchema');
    if (named.length === 0) {
        if (a.composition !== undefined) {
            named.push(a.composition === 'oneOf' ? 'one of' : 'any of');
        } else if (a.const !== undefined) {
            named.push(a.const === null ? 'null' : Array.isArray(a.const) ? 'array' : typeof a.const);
        } else if (stream !== undefined) {
            named.push(`stream of ${typeLabel(stream)}`);
        } else if (types.length === 0) {
            named.push('any');
        }
    }
    return types.includes('null') || a.nullable ? [...named, 'null'].join(' | ') : named.join(' | ');
}

function singleTypeLabel(type: string, node: Pick<DiffNode, 'attrs' | 'children'>): string {
    const a = node.attrs;
    if (type === 'array') {
        const items = arrayItems(node);
        return `array[${items === undefined ? 'any' : typeLabel(items)}]`;
    }
    if (type === 'object' && a.title !== undefined) {
        return a.title;
    }
    return a.format === undefined ? type : `${type}<${a.format}>`;
}

/** The `items` child of an array node, when it has one. */
export function arrayItems<T extends Pick<DiffNode, 'children'>>(node: T): T['children'][number] | undefined {
    return node.children.find((child) => child.kind === 'items' && child.key === '[]');
}

/** Short badges for the facts of a node, in display order. */
export function badges(attrs: Attrs): string[] {
    const out: string[] = [];
    /** Add a badge for a fact that is present. `false` is a value to show, not an absent fact. */
    const add = (value: unknown, text: () => string) => {
        if (value !== undefined) {
            out.push(text());
        }
    };
    const flag = (value: boolean | undefined, text: string) => add(value === true ? true : undefined, () => text);
    flag(attrs.required, 'required');
    flag(attrs.deprecated, 'deprecated');
    flag(attrs.readOnly, 'read-only');
    flag(attrs.writeOnly, 'write-only');
    add(attrs.minimum, () => `>= ${attrs.minimum}`);
    add(attrs.exclusiveMinimum, () => `> ${attrs.exclusiveMinimum}`);
    add(attrs.maximum, () => `<= ${attrs.maximum}`);
    add(attrs.exclusiveMaximum, () => `< ${attrs.exclusiveMaximum}`);
    add(attrs.multipleOf, () => `multiple of ${attrs.multipleOf}`);
    out.push(...rangeBadges(attrs.minLength, attrs.maxLength, 'characters'));
    out.push(...rangeBadges(attrs.minItems, attrs.maxItems, 'items'));
    out.push(...rangeBadges(attrs.minProperties, attrs.maxProperties, 'properties'));
    flag(attrs.uniqueItems, 'unique items');
    add(attrs.pattern, () => `pattern ${attrs.pattern}`);
    add(attrs.contentMediaType, () => `media type ${attrs.contentMediaType}`);
    add(attrs.contentEncoding, () => `encoding ${attrs.contentEncoding}`);
    flag(attrs.additionalProperties === false, 'no additional properties');
    add(attrs.default, () => `default: ${formatValue(attrs.default)}`);
    add(attrs.style, () => `style: ${attrs.style}`);
    add(attrs.explode, () => `explode: ${attrs.explode}`);
    flag(attrs.allowReserved, 'allow reserved');
    flag(attrs.allowEmptyValue, 'allow empty value');
    add(attrs.contentType, () => `content: ${attrs.contentType}`);
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

/** An attribute value in a change line. An absent value shows as `(none)`. */
export function changeValue(change: AttrChange, side: 'before' | 'after'): string {
    const value = change[side];
    if (value === undefined) {
        return change.name === 'required' ? 'optional' : '(none)';
    }
    if (change.name === 'required') {
        return 'required';
    }
    if (change.name === 'type') {
        return (value as string[]).join(' | ');
    }
    if (change.name === 'examples') {
        return Object.keys(value as Record<string, JsonValue>).join(', ');
    }
    if (Array.isArray(value)) {
        return value.map((item) => formatValue(item, 40)).join(', ');
    }
    return formatValue(value, 60);
}
