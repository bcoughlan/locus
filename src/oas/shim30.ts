/**
 * The OpenAPI 3.0 to 3.1 shim for Schema Objects. 3.0 schemas use a dialect
 * of JSON Schema with `nullable` and boolean `exclusiveMinimum`/`exclusiveMaximum`.
 * 3.1 uses plain JSON Schema. After this shim, the model sees one dialect.
 */
import { getNumber } from '../util.ts';

/**
 * Convert the keywords of one 3.0 schema object to their 3.1 form. Nested
 * schemas stay as they are: the model builder converts each schema it visits.
 */
export function upgradeSchema30(schema: Record<string, unknown>): Record<string, unknown> {
    const { nullable, ...out } = schema;

    // `exclusiveMaximum: true` modifies `maximum`. In 3.1 it holds the limit itself.
    for (const [exclusive, inclusive] of [
        ['exclusiveMaximum', 'maximum'],
        ['exclusiveMinimum', 'minimum'],
    ] as const) {
        if (typeof out[exclusive] !== 'boolean') {
            continue;
        }
        const limit = getNumber(out[inclusive]);
        if (out[exclusive] === true && limit !== undefined) {
            out[exclusive] = limit;
            delete out[inclusive];
        } else {
            delete out[exclusive];
        }
    }

    if (nullable !== true) {
        return out;
    }
    // `nullable: true` adds null to the allowed values: a "null" type, or else
    // (for a schema without a single type, such as an `allOf`) a null alternative.
    if (typeof out.type === 'string') {
        return { ...out, type: [out.type, 'null'] };
    }
    return { anyOf: [out, { type: 'null' }] };
}
