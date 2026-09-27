/** CLI behavior: arguments, file selection, pairing, exit codes, and color. */
import { describe, expect, test } from 'vitest';
import { inTmp, openapi, runLocus } from './helpers.ts';

const listPets = openapi("  /pets:\n    get:\n      operationId: listPets\n      responses: {'200': {description: OK}}");
const listPetsWithLimit = openapi(
    "  /pets:\n    get:\n      operationId: listPets\n      parameters: [{name: limit, in: query, required: true, schema: {type: integer}}]\n      responses: {'200': {description: OK}}",
);
const listPetsDocumented = listPets.replace('operationId: listPets', 'operationId: listPets\n      description: Lists the pets.');

describe('exit codes', () => {
    test('0 when nothing changed', async () => {
        await inTmp({ 'old/api.yml': listPets, 'new/api.yml': listPets }, async (dir) => {
            const result = await runLocus(['diff', '--source', 'old', 'new'], dir);
            expect(result).toMatchObject({ code: 0, stderr: '' });
            expect(result.stdout).toContain('Result: no breaking changes.');
        });
    });

    test('0 for compatible changes', async () => {
        await inTmp({ 'old/api.yml': listPets, 'new/api.yml': listPetsDocumented }, async (dir) => {
            expect((await runLocus(['diff', '--source', 'old', 'new'], dir)).code).toBe(0);
        });
    });

    test('1 for breaking changes', async () => {
        await inTmp({ 'old/api.yml': listPets, 'new/api.yml': listPetsWithLimit }, async (dir) => {
            const result = await runLocus(['diff', '--source', 'old', 'new'], dir);
            expect(result.code).toBe(1);
            expect(result.stdout).toContain('[breaking: required query parameter added]');
        });
    });

    test('2 for a usage error', async () => {
        await inTmp({}, async (dir) => {
            const result = await runLocus(['diff'], dir);
            expect(result.code).toBe(2);
            expect(result.stderr).toContain("missing required argument 'specs'");
        });
    });

    test('2 when --base and --source are both given', async () => {
        await inTmp({ 'api.yml': listPets }, async (dir) => {
            const result = await runLocus(['diff', '--base', 'main', '--source', 'api.yml', 'api.yml'], dir);
            expect(result.code).toBe(2);
            expect(result.stderr).toContain("option '--base <ref>' cannot be used with option '--source <pattern>'");
        });
    });

    test('2 for a file that does not exist', async () => {
        await inTmp({ 'api.yml': listPets }, async (dir) => {
            const result = await runLocus(['diff', '--source', 'missing.yml', 'api.yml'], dir);
            expect(result).toMatchObject({ code: 2, stdout: '', stderr: 'error: missing.yml: no such file or folder\n' });
        });
    });

    test('2 for a file that does not parse, named relative to the current folder', async () => {
        await inTmp({ 'old.yml': listPets, 'new.yml': 'openapi: [3.1' }, async (dir) => {
            const result = await runLocus(['diff', '--source', 'old.yml', 'new.yml'], dir);
            expect(result.code).toBe(2);
            expect(result.stderr).toMatch(/^error: new\.yml: /);
        });
    });

    test('2 for a Swagger 2.0 document', async () => {
        await inTmp({ 'old.yml': 'swagger: "2.0"', 'new.yml': listPets }, async (dir) => {
            const result = await runLocus(['diff', '--source', 'old.yml', 'new.yml'], dir);
            expect(result).toMatchObject({ code: 2, stderr: 'error: old.yml: Swagger 2.0 documents are not supported. Convert the document to OpenAPI 3 first.\n' });
        });
    });

    test('2 when a named file is not an OpenAPI document', async () => {
        await inTmp({ 'schemas.yml': 'Pet: {type: object}', 'api.yml': listPets }, async (dir) => {
            const result = await runLocus(['diff', '--source', 'schemas.yml', 'api.yml'], dir);
            expect(result).toMatchObject({ code: 2, stderr: 'error: schemas.yml: not an OpenAPI document (it has no "openapi" field)\n' });
        });
    });

    test('2 when --source selects no OpenAPI document, so a wrong pattern cannot pass as "all new"', async () => {
        await inTmp({ 'old/api.yml': listPets, 'new/api.yml': listPets }, async (dir) => {
            const result = await runLocus(['diff', '--source', 'old/*.yaml', 'new'], dir);
            expect(result).toMatchObject({ code: 2, stderr: 'error: No OpenAPI documents found in --source old/*.yaml\n' });
        });
    });

    test('2 when the head selects no OpenAPI document', async () => {
        await inTmp({ 'old/api.yml': listPets, 'new/notes.yml': 'a: 1' }, async (dir) => {
            const result = await runLocus(['diff', '--source', 'old', 'new'], dir);
            expect(result).toMatchObject({ code: 2, stderr: 'error: No OpenAPI documents found in new\n' });
        });
    });

    test('--version prints the package version and exits 0', async () => {
        const result = await runLocus(['--version'], '.');
        expect(result.code).toBe(0);
        expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
    });
});

describe('file selection and pairing', () => {
    test('folders pair files by their path below the folder, and skip shared schema files', async () => {
        await inTmp(
            {
                'old/pets.yml': listPets,
                'old/users.yml': listPets.replace(/pets/g, 'users'),
                'old/common/schemas.yml': 'Pet: {type: object}',
                'new/pets.yml': listPetsWithLimit,
                'new/orders.yml': listPets.replace(/pets/g, 'orders'),
                'new/common/schemas.yml': 'Pet: {type: object}',
            },
            async (dir) => {
                const result = await runLocus(['diff', '--no-color', '--source', 'old', 'new'], dir);
                expect(result.stdout).toContain('+ new/orders.yml (new file)');
                expect(result.stdout).toContain('~ new/pets.yml');
                expect(result.stdout).toContain('- old/users.yml (deleted)');
                expect(result.stdout).not.toContain('schemas.yml');
            },
        );
    });

    test('glob patterns select files; the pattern folder is the pairing root', async () => {
        await inTmp({ 'old/specs/api.yml': listPets, 'specs/api.yml': listPetsWithLimit, 'specs/readme.md': '# x' }, async (dir) => {
            const result = await runLocus(['diff', '--no-color', '--source', 'old/specs/*.yml', 'specs/*.yml'], dir);
            expect(result.code).toBe(1);
            expect(result.stdout).toContain('Comparing old/specs/*.yml → specs/*.yml');
            expect(result.stdout).toContain('~ specs/api.yml');
        });
    });

    test('YAML in a folder that is not OpenAPI and does not parse is skipped', async () => {
        await inTmp({ 'old/api.yml': listPets, 'new/api.yml': listPets, 'new/chart/values.yml': 'image: {{ .Values.image }}\n  bad: [' }, async (dir) => {
            const result = await runLocus(['diff', '--source', 'old', 'new'], dir);
            expect(result).toMatchObject({ code: 0, stderr: '' });
        });
    });

    test('two single files pair even when their names differ', async () => {
        await inTmp({ 'v1.yml': listPets, 'v2.yml': listPetsWithLimit }, async (dir) => {
            const result = await runLocus(['diff', '--no-color', '--source', 'v1.yml', 'v2.yml'], dir);
            expect(result.code).toBe(1);
            expect(result.stdout).toContain('~ v2.yml');
        });
    });

    test('$refs into other files resolve on both sides', async () => {
        await inTmp(
            {
                'old/api.yml': openapi("  /pets:\n    get:\n      responses: {'200': {description: OK, content: {application/json: {schema: {$ref: 'schemas/pet.yml'}}}}}"),
                'old/schemas/pet.yml': 'type: object\nproperties: {name: {type: string}}',
                'new/api.yml': openapi("  /pets:\n    get:\n      responses: {'200': {description: OK, content: {application/json: {schema: {$ref: 'schemas/pet.yml'}}}}}"),
                'new/schemas/pet.yml': 'type: object\nproperties: {nickname: {type: string}}',
            },
            async (dir) => {
                const result = await runLocus(['diff', '--no-color', '--source', 'old', 'new'], dir);
                expect(result.code).toBe(1);
                expect(result.stdout).toMatch(/^- +name {2}string {2}\[breaking: property removed\]$/m);
                expect(result.stdout).toMatch(/^\+ +nickname {2}string$/m);
            },
        );
    });
});

describe('output', () => {
    test('an unchanged document with warnings still shows its warnings', async () => {
        const broken = openapi("  /a:\n    get:\n      responses: {'200': {description: OK, content: {application/json: {schema: {$ref: 'missing.yml'}}}}}");
        await inTmp({ 'old.yml': broken, 'new.yml': broken }, async (dir) => {
            const result = await runLocus(['diff', '--no-color', '--source', 'old.yml', 'new.yml'], dir);
            expect(result.code).toBe(0);
            expect(result.stdout).toContain('warning: Unresolved $ref "missing.yml" in new.yml (missing.yml: cannot read file (ENOENT))');
        });
    });

    test('explode: false and default: false show as badges', async () => {
        const api = (extra: string) =>
            openapi(`  /a:\n    get:\n      parameters: [{name: ids, in: query, explode: false, schema: {type: array, items: {type: string}}}, {name: all, in: query, schema: {type: boolean, default: false}}${extra}]\n      responses: {}`);
        await inTmp({ 'old.yml': api(''), 'new.yml': api(', {name: x, in: query}') }, async (dir) => {
            const result = await runLocus(['diff', '--no-color', '--source', 'old.yml', 'new.yml'], dir);
            expect(result.stdout).toMatch(/ids {2}array\[string\] {2}explode: false$/m);
            expect(result.stdout).toMatch(/all {2}boolean {2}default: false$/m);
        });
    });
});

describe('output options', () => {
    test('unchanged endpoints show only with --all', async () => {
        const api = (extra: string) => openapi(`  /a: {get: {responses: {}}}\n  /b: {get: {${extra}responses: {}}}`);
        await inTmp({ 'old.yml': api(''), 'new.yml': api('description: B, ') }, async (dir) => {
            const plain = await runLocus(['diff', '--no-color', '--source', 'old.yml', 'new.yml'], dir);
            expect(plain.stdout).not.toContain('GET /a');
            expect(plain.stdout).toContain('Run with --all to show the unchanged endpoints.');
            const all = await runLocus(['diff', '--no-color', '--all', '--source', 'old.yml', 'new.yml'], dir);
            expect(all.stdout).toContain('GET /a');
        });
    });

    test('colors by default when the terminal supports them, none with --no-color', async () => {
        await inTmp({ 'old.yml': listPets, 'new.yml': listPetsWithLimit }, async (dir) => {
            const colored = await runLocus(['diff', '--source', 'old.yml', 'new.yml'], dir, 3);
            expect(colored.stdout).toContain('\u001b[31m'); // red: the breaking change
            const plain = await runLocus(['diff', '--no-color', '--source', 'old.yml', 'new.yml'], dir, 3);
            expect(plain.stdout).not.toContain('\u001b[');
        });
    });

    test('a 16-color terminal gets basic color codes, not truecolor', async () => {
        await inTmp({ 'old.yml': listPets, 'new.yml': listPetsDocumented }, async (dir) => {
            const result = await runLocus(['diff', '--source', 'old.yml', 'new.yml'], dir, 1);
            expect(result.stdout).toContain('\u001b[');
            expect(result.stdout).not.toContain('\u001b[38;2;');
        });
    });
});
