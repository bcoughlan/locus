/**
 * Builds docs/developer-guide.html: renders each d2 diagram in
 * docs/dev-guide/diagrams/ to PNG and inlines it as a data URL, so the guide
 * is one self-contained file.
 *
 * Needs the d2 CLI (https://d2lang.com). Set D2 to its path when it is not on the PATH:
 *   D2=/path/to/d2 node scripts/build-dev-guide.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const template = readFileSync(join(root, 'docs/dev-guide/guide.html'), 'utf8');
const d2 = process.env.D2 ?? 'd2';
const out = mkdtempSync(join(tmpdir(), 'locus-guide-'));

try {
    // A placeholder <img data-diagram="name" alt="..."> becomes an <img> with the rendered PNG.
    const html = template.replace(/<img data-diagram="([\w-]+)"/g, (_match, name) => {
        const file = join(out, `${name}.png`);
        execFileSync(d2, ['--pad', '24', '--scale', '1', join(root, 'docs/dev-guide/diagrams', `${name}.d2`), file], { stdio: 'pipe' });
        const png = readFileSync(file);
        // d2 renders PNGs at twice their size. Show them at half, so they stay sharp on high-DPI screens.
        // The width sits in the PNG header (IHDR), bytes 16 to 19.
        const width = Math.round(png.readUInt32BE(16) / 2);
        return `<img width="${width}" src="data:image/png;base64,${png.toString('base64')}"`;
    });
    writeFileSync(join(root, 'docs/developer-guide.html'), html);
    console.log(`Wrote docs/developer-guide.html (${Math.round(html.length / 1024)} KB)`);
} finally {
    rmSync(out, { recursive: true, force: true });
}
