/**
 * CLI behavior: arguments, file selection, pairing, exit codes, and color.
 * Each test snapshots the whole run (see `transcript`).
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { inTmp, openapi, runLocus, transcript } from './helpers.ts';

const listPets = openapi("  /pets:\n    get:\n      operationId: listPets\n      responses: {'200': {description: OK}}");
const listPetsWithLimit = openapi(
    "  /pets:\n    get:\n      operationId: listPets\n      parameters: [{name: limit, in: query, required: true, schema: {type: integer}}]\n      responses: {'200': {description: OK}}",
);
const listPetsDocumented = listPets.replace('operationId: listPets', 'operationId: listPets\n      description: Lists the pets.');

/** Run `locus` in a temporary folder with `files`, and snapshot the run. */
async function snapshot(files: Record<string, string>, args: string[]): Promise<void> {
    await inTmp(files, async (dir) => {
        expect(transcript(await runLocus(args, dir), dir)).toMatchSnapshot();
    });
}

describe('exit codes', () => {
    test('0 when nothing changed', async () => {
        await snapshot({ 'old/api.yml': listPets, 'new/api.yml': listPets }, ['diff', '--source', 'old', 'new']);
    });

    test('0 for compatible changes', async () => {
        await snapshot({ 'old/api.yml': listPets, 'new/api.yml': listPetsDocumented }, ['diff', '--source', 'old', 'new']);
    });

    test('1 for breaking changes', async () => {
        await snapshot({ 'old/api.yml': listPets, 'new/api.yml': listPetsWithLimit }, ['diff', '--source', 'old', 'new']);
    });

    test('2 for a usage error', async () => {
        await snapshot({}, ['diff']);
    });

    test('2 when --base and --source are both given', async () => {
        await snapshot({ 'api.yml': listPets }, ['diff', '--base', 'main', '--source', 'api.yml', 'api.yml']);
    });

    test('2 for a file that does not exist', async () => {
        await snapshot({ 'api.yml': listPets }, ['diff', '--source', 'missing.yml', 'api.yml']);
    });

    test('2 for a file that does not parse, named relative to the current folder', async () => {
        await snapshot({ 'old.yml': listPets, 'new.yml': 'openapi: [3.1' }, ['diff', '--source', 'old.yml', 'new.yml']);
    });

    test('2 for a Swagger 2.0 document', async () => {
        await snapshot({ 'old.yml': 'swagger: "2.0"', 'new.yml': listPets }, ['diff', '--source', 'old.yml', 'new.yml']);
    });

    test('2 when a named file is not an OpenAPI document', async () => {
        await snapshot({ 'schemas.yml': 'Pet: {type: object}', 'api.yml': listPets }, ['diff', '--source', 'schemas.yml', 'api.yml']);
    });

    test('2 when --source selects no OpenAPI document, so a wrong pattern cannot pass as "all new"', async () => {
        await snapshot({ 'old/api.yml': listPets, 'new/api.yml': listPets }, ['diff', '--source', 'old/*.yaml', 'new']);
    });

    test('2 when the head selects no OpenAPI document', async () => {
        await snapshot({ 'old/api.yml': listPets, 'new/notes.yml': 'a: 1' }, ['diff', '--source', 'old', 'new']);
    });

    test('--version prints the package version and exits 0', async () => {
        const result = await runLocus(['--version'], '.');
        expect(result.code).toBe(0);
        expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
    });
});

describe('file selection and pairing', () => {
    test('folders pair files by their path below the folder, and skip shared schema files', async () => {
        await snapshot(
            {
                'old/pets.yml': listPets,
                'old/users.yml': listPets.replace(/pets/g, 'users'),
                'old/common/schemas.yml': 'Pet: {type: object}',
                'new/pets.yml': listPetsWithLimit,
                'new/orders.yml': listPets.replace(/pets/g, 'orders'),
                'new/common/schemas.yml': 'Pet: {type: object}',
            },
            ['diff', '--no-color', '--source', 'old', 'new'],
        );
    });

    test('glob patterns select files; the pattern folder is the pairing root', async () => {
        await snapshot({ 'old/specs/api.yml': listPets, 'specs/api.yml': listPetsWithLimit, 'specs/readme.md': '# x' }, [
            'diff',
            '--no-color',
            '--source',
            'old/specs/*.yml',
            'specs/*.yml',
        ]);
    });

    test('YAML in a folder that is not OpenAPI and does not parse is skipped', async () => {
        await snapshot({ 'old/api.yml': listPets, 'new/api.yml': listPets, 'new/chart/values.yml': 'image: {{ .Values.image }}\n  bad: [' }, [
            'diff',
            '--source',
            'old',
            'new',
        ]);
    });

    test('two single files pair even when their names differ', async () => {
        await snapshot({ 'v1.yml': listPets, 'v2.yml': listPetsWithLimit }, ['diff', '--no-color', '--source', 'v1.yml', 'v2.yml']);
    });

    test('$refs into other files resolve on both sides', async () => {
        const api = openapi("  /pets:\n    get:\n      responses: {'200': {description: OK, content: {application/json: {schema: {$ref: 'schemas/pet.yml'}}}}}");
        await snapshot(
            {
                'old/api.yml': api,
                'old/schemas/pet.yml': 'type: object\nproperties: {name: {type: string}}',
                'new/api.yml': api,
                'new/schemas/pet.yml': 'type: object\nproperties: {nickname: {type: string}}',
            },
            ['diff', '--no-color', '--source', 'old', 'new'],
        );
    });
});

describe('output', () => {
    test('an unchanged document with warnings still shows its warnings', async () => {
        const broken = openapi("  /a:\n    get:\n      responses: {'200': {description: OK, content: {application/json: {schema: {$ref: 'missing.yml'}}}}}");
        await snapshot({ 'old.yml': broken, 'new.yml': broken }, ['diff', '--no-color', '--source', 'old.yml', 'new.yml']);
    });

    test('explode: false and default: false show as badges', async () => {
        const api = (extra: string) =>
            openapi(
                `  /a:\n    get:\n      parameters: [{name: ids, in: query, explode: false, schema: {type: array, items: {type: string}}}, {name: all, in: query, schema: {type: boolean, default: false}}${extra}]\n      responses: {}`,
            );
        await snapshot({ 'old.yml': api(''), 'new.yml': api(', {name: x, in: query}') }, ['diff', '--no-color', '--source', 'old.yml', 'new.yml']);
    });

    test('a large endpoint shows only the shortest paths to its changes', async () => {
        // 400 request properties make the endpoint large before its responses print.
        const filler = Array.from({ length: 400 }, (_, i) => `field${i}: {type: string}`).join(', ');
        const ref = (name: string) => `{$ref: '#/components/schemas/${name}'}`;
        const api = (address: string) =>
            openapi(
                `  /orders:
    post:
      requestBody: {content: {application/json: {schema: {type: object, properties: {${filler}}}}}}
      responses: {'200': {description: OK, content: {application/json: {schema: ${ref('Order')}}}}}`,
                `components:
  schemas:
    Order: {type: object, properties: {id: {type: string}, customer: ${ref('Customer')}, seller: ${ref('Customer')}, items: {type: array, items: ${ref('Item')}}, note: {type: string}}}
    Customer: {type: object, properties: {name: {type: string}, address: ${ref('Address')}, orders: {type: array, items: ${ref('Order')}}}}
    Item: {type: object, properties: {sku: {type: string}, product: ${ref('Product')}}}
    Product: {type: object, properties: {name: {type: string}, maker: ${ref('Customer')}}}
    Address: {type: object, properties: {${address}}}`,
            );
        await inTmp({ 'old.yml': api('street: {type: string}, city: {type: string}, zip: {type: string}'), 'new.yml': api('street: {type: string}, city: {type: string}') }, async (dir) => {
            const { stdout } = await runLocus(['diff', '--no-color', '--source', 'old.yml', 'new.yml'], dir);
            // Only the part after the filler: the path from Order to the removed zip property.
            expect(stdout.slice(stdout.indexOf('      Responses'))).toMatchSnapshot();
        });
    });

    test('unchanged endpoints show only with --all', async () => {
        const api = (extra: string) => openapi(`  /a: {get: {responses: {}}}\n  /b: {get: {${extra}responses: {}}}`);
        const files = { 'old.yml': api(''), 'new.yml': api('description: B, ') };
        await snapshot(files, ['diff', '--no-color', '--source', 'old.yml', 'new.yml']);
        await snapshot(files, ['diff', '--no-color', '--all', '--source', 'old.yml', 'new.yml']);
    });
});

describe('--html', () => {
    // A pet store with changes of every kind: parameters, enums, a new endpoint, a removed one, and a Markdown description.
    const fixture = join(import.meta.dirname, 'fixtures', 'html');
    const base = readFileSync(join(fixture, 'base.yml'), 'utf8');
    const head = readFileSync(join(fixture, 'head.yml'), 'utf8');

    test('writes an HTML page next to the console output', async () => {
        await inTmp({ 'old.yml': base, 'new.yml': head }, async (dir) => {
            const result = await runLocus(['diff', '--no-color', '--html', 'out/report.html', '--source', 'old.yml', 'new.yml'], dir);
            expect(transcript(result, dir)).toMatchSnapshot();
            const html = await readFile(join(dir, 'out/report.html'), 'utf8');
            // Text and links from the input documents are escaped.
            expect(html).not.toContain('<script>alert');
            expect(html).not.toContain('href="javascript:');
            await expect(html).toMatchFileSnapshot('__snapshots__/report.html');
        });
    });

    test('with --all, the page opens with the unchanged endpoints shown', async () => {
        await inTmp({ 'old.yml': base, 'new.yml': head }, async (dir) => {
            await runLocus(['diff', '--all', '--html', 'report.html', '--source', 'old.yml', 'new.yml'], dir);
            expect(await readFile(join(dir, 'report.html'), 'utf8')).toContain('<body class="show-all">');
        });
    });

    // The reason comes from the operating system and differs between platforms, so no snapshot.
    test('2 when the file cannot be written', async () => {
        await inTmp({ 'old.yml': base, 'new.yml': head, taken: 'a file, not a folder' }, async (dir) => {
            const result = await runLocus(['diff', '--no-color', '--html', 'taken/report.html', '--source', 'old.yml', 'new.yml'], dir);
            expect(result.code).toBe(2);
            expect(result.stderr).toMatch(/^error: Cannot write the HTML report to taken\/report\.html: /);
        });
    });
});

// Color codes are unreadable in a snapshot, so these tests check them directly.
describe('color', () => {
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
