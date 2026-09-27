/**
 * Guards for reading untrusted parsed YAML/JSON. Input documents can hold any
 * shape, so code reads fields through these helpers instead of trusting types.
 */

/** A plain object map, or `undefined` for anything else (null and arrays included). */
export function asObject(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

export function getArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

export function getString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/** A non-empty string after trimming, or `undefined`. */
export function getText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function getNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function getBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

export function getStringArray(value: unknown): string[] {
    return getArray(value).filter((item): item is string => typeof item === 'string');
}

/** The `$ref` string of a reference node, or `undefined` when the node is not a reference. */
export function refString(node: unknown): string | undefined {
    return getString(asObject(node)?.$ref);
}

/** JSON text with object keys sorted, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, inner: unknown) => {
        const object = asObject(inner);
        return object === undefined ? inner : Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
    });
}

/** Items of `a` that `b` lacks, compared as JSON values. Anything that is not an array counts as empty. */
export function jsonDifference(a: unknown, b: unknown): unknown[] {
    const other = new Set((Array.isArray(b) ? b : []).map(canonicalJson));
    return (Array.isArray(a) ? a : []).filter((item) => !other.has(canonicalJson(item)));
}

/** `decode(value)`, or `value` unchanged when it is not validly encoded. */
export function tryDecode(decode: (value: string) => string, value: string): string {
    try {
        return decode(value);
    } catch {
        return value;
    }
}
