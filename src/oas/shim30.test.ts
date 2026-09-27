import { describe, expect, test } from 'vitest';
import { upgradeSchema30 } from './shim30.ts';

describe('upgradeSchema30', () => {
    test('nullable becomes a "null" type', () => {
        expect(upgradeSchema30({ type: 'string', nullable: true })).toEqual({ type: ['string', 'null'] });
    });

    test('nullable: false is dropped', () => {
        expect(upgradeSchema30({ type: 'string', nullable: false })).toEqual({ type: 'string' });
    });

    test('nullable without a single type becomes a null alternative', () => {
        const allOf = [{ $ref: '#/components/schemas/Pet' }];
        expect(upgradeSchema30({ nullable: true, allOf })).toEqual({ anyOf: [{ allOf }, { type: 'null' }] });
    });

    test('boolean exclusiveMaximum moves the limit into exclusiveMaximum', () => {
        expect(upgradeSchema30({ type: 'integer', maximum: 10, exclusiveMaximum: true })).toEqual({
            type: 'integer',
            exclusiveMaximum: 10,
        });
    });

    test('exclusiveMinimum: false keeps minimum inclusive', () => {
        expect(upgradeSchema30({ minimum: 1, exclusiveMinimum: false })).toEqual({ minimum: 1 });
    });

    test('exclusiveMinimum: true without minimum is dropped', () => {
        expect(upgradeSchema30({ exclusiveMinimum: true })).toEqual({});
    });

    test('does not change the input object', () => {
        const input = { type: 'string', nullable: true };
        upgradeSchema30(input);
        expect(input).toEqual({ type: 'string', nullable: true });
    });
});
