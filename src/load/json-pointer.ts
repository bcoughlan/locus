/** JSON Pointer (RFC 6901) helpers. Adapted from apion (`src/lib/oas/json-pointer.ts`). */
import { tryDecode } from '../util.ts';

/**
 * Split a pointer into unescaped reference tokens. Accepts the fragment form
 * (`#/a/b`) and the plain form (`/a/b`). `#` and `#/` address the whole document.
 */
export function pointerToParts(pointer: string): string[] {
    let body = pointer.startsWith('#') ? pointer.slice(1) : pointer;
    if (body.startsWith('/')) {
        body = body.slice(1);
    }
    if (body === '') {
        return [];
    }
    // A `$ref` fragment is URI-encoded (`#/paths/~1pets%7Bid%7D`), so decode it before `~` unescaping.
    return body.split('/').map((part) => tryDecode(decodeURIComponent, part).replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Build a `#/`-prefixed pointer from unescaped reference tokens. */
export function partsToPointer(parts: string[]): string {
    return '#/' + parts.map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

/** A pointer to a child: `#/paths` plus `/pets`, `get` gives `#/paths/~1pets/get`. */
export function appendPointer(pointer: string, ...parts: (string | number)[]): string {
    return partsToPointer([...pointerToParts(pointer), ...parts.map(String)]);
}

/** The node at the path `parts` in `doc`, or `undefined` when a step is missing. */
export function getByParts(doc: unknown, parts: string[]): unknown {
    let node = doc;
    for (const part of parts) {
        if (node === null || typeof node !== 'object' || !Object.hasOwn(node, part)) {
            return undefined;
        }
        node = (node as Record<string, unknown>)[part];
    }
    return node;
}
