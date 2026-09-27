/**
 * Places in loaded documents: {@link Located} values, and the JSON Pointer
 * (RFC 6901) helpers. The pointer parser is adapted from apion
 * (`src/lib/oas/json-pointer.ts`).
 */
import { basename, extname } from 'node:path';
import { asObject, tryDecode } from '../util.ts';

/**
 * A value in a loaded file, with its place: the file and the JSON pointer.
 * The model walks documents with it, so each node knows where it is defined.
 * A step to a child costs no string work. The pointer text is built on first
 * use.
 */
export class Located<T = unknown> {
    readonly value: T;
    /** Absolute path of the file. */
    readonly file: string;
    /** Absent for the whole file. */
    private readonly parent: Located | undefined;
    /** The key in the parent that leads here, unescaped. */
    private readonly token: string;
    private cachedPointer: string | undefined;
    private cachedId: string | undefined;

    private constructor(value: T, file: string, parent: Located | undefined, token: string) {
        this.value = value;
        this.file = file;
        this.parent = parent;
        this.token = token;
    }

    /** The whole file. */
    static root<T>(value: T, file: string): Located<T> {
        return new Located(value, file, undefined, '');
    }

    /** JSON pointer, for example `#/paths/~1pets/get`. `#` for the whole file. */
    get pointer(): string {
        this.cachedPointer ??= this.parent === undefined ? '#' : `${this.parent.pointer}/${escapeToken(this.token)}`;
        return this.cachedPointer;
    }

    /** Identity of the place: `<file>#<pointer>`. */
    get id(): string {
        this.cachedId ??= `${this.file}${this.pointer}`;
        return this.cachedId;
    }

    /** The key of the value (`Pet` for `#/components/schemas/Pet`), or the file name for a whole file. */
    get name(): string {
        return this.parent === undefined ? basename(this.file, extname(this.file)) : this.token;
    }

    /** The file and the pointer, for the `source` of a model node. */
    get source(): { file: string; pointer: string } {
        return { file: this.file, pointer: this.pointer };
    }

    /**
     * The value at a path of keys below this one. A missing step gives the
     * value `undefined`. Only own properties count, so an untrusted key such
     * as `constructor` finds nothing.
     */
    at(...keys: (string | number)[]): Located {
        return keys.reduce<Located>((loc, key) => loc.child(String(key)), this);
    }

    /** The entries of an object value. Empty for anything else, arrays included. */
    entries(): [string, Located][] {
        return Object.keys(asObject(this.value) ?? {}).map((key) => [key, this.child(key)]);
    }

    /** The items of an array value. Empty for anything else. */
    items(): Located[] {
        return Array.isArray(this.value) ? this.value.map((_, i) => this.child(String(i))) : [];
    }

    /** The same place with another value, for example a schema after the 3.0 shim. */
    with<U>(value: U): Located<U> {
        return new Located(value, this.file, this.parent, this.token);
    }

    private child(token: string): Located {
        const container = this.value;
        const value = container !== null && typeof container === 'object' && Object.hasOwn(container, token) ? (container as Record<string, unknown>)[token] : undefined;
        return new Located(value, this.file, this, token);
    }
}

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

function escapeToken(token: string): string {
    return token.replace(/~/g, '~0').replace(/\//g, '~1');
}
