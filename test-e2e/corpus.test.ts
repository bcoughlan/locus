/**
 * Runs every scenario in `test-e2e/corpus/` (see its README): a snapshot of
 * the output, plus a check of the class that `scenario.yml` expects.
 */
import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { runLocus } from './helpers.ts';

interface Scenario {
    description: string;
    expect: 'breaking' | 'compatible' | 'unchanged';
}

const CORPUS = join(import.meta.dirname, 'corpus');
const scenarios = globSync('*/*/scenario.yml', { cwd: CORPUS })
    .map((file) => dirname(file).replace(/\\/g, '/'))
    .sort();

const EXPECTED: Record<Scenario['expect'], { exitCode: number; changed: boolean }> = {
    breaking: { exitCode: 1, changed: true },
    compatible: { exitCode: 0, changed: true },
    unchanged: { exitCode: 0, changed: false },
};

test.each(scenarios)('%s', async (name) => {
    const dir = join(CORPUS, name);
    const scenario = parse(readFileSync(join(dir, 'scenario.yml'), 'utf8')) as Scenario;
    const result = await runLocus(['diff', '--no-color', '--source', 'base', 'head'], dir);

    expect(result.stderr).toBe('');
    const snapshot = `# ${scenario.description.trim()}\n$ locus diff --no-color --source base head\nexit code: ${result.code}\n\n${result.stdout}`;
    await expect(snapshot).toMatchFileSnapshot(join(dir, 'output.txt'));
    // A line that starts with a change marker means the report lists a change.
    const changed = /^[~+-] /m.test(result.stdout);
    expect({ exitCode: result.code, changed }).toEqual(EXPECTED[scenario.expect]);
});
