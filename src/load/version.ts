import { InputError } from '../errors.ts';
import { asObject } from '../util.ts';

/**
 * The two OpenAPI families that the model distinguishes. 3.0 schemas need a
 * shim. 3.1 to 3.2 is not a breaking change, so 3.1 documents use the 3.2 code.
 */
export type OasFamily = '3.0' | '3.1+';

export interface OasVersion {
    /** The `openapi` field as written, for example `3.1.0`. */
    raw: string;
    family: OasFamily;
}

/**
 * The OpenAPI version of a root document, or `undefined` when the document is
 * not an OpenAPI document (for example a file of shared schemas). Throws
 * {@link InputError} for Swagger 2.0 and unknown versions.
 */
export function detectVersion(root: unknown, file: string): OasVersion | undefined {
    const doc = asObject(root);
    if (doc?.swagger !== undefined) {
        throw new InputError(`${file}: Swagger 2.0 documents are not supported. Convert the document to OpenAPI 3 first.`);
    }
    // Unquoted YAML such as `openapi: 3.0` parses as a number (3), so restore the minor version.
    const version = doc?.openapi;
    const raw = typeof version === 'number' ? (Number.isInteger(version) ? version.toFixed(1) : String(version)) : version;
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw !== 'string' || !/^3\.\d+/.test(raw)) {
        throw new InputError(`${file}: unsupported OpenAPI version ${JSON.stringify(raw)}`);
    }
    return { raw, family: raw.startsWith('3.0') ? '3.0' : '3.1+' };
}
