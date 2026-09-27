/**
 * Builds docs/developer-guide.html: renders each d2 diagram in
 * docs/dev-guide/diagrams/ to PNG and inlines it as a data URL, so the guide
 * is one self-contained file. Run it with `npm run docs:guide`.
 *
 * The d2 CLI (https://d2lang.com) comes from, in this order: the D2
 * environment variable, `d2` on the PATH, or a pinned d2 release. The script
 * downloads that release once into node_modules/.cache/d2 and checks its
 * SHA-256 before it uses it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

const D2_VERSION = 'v0.9.0';
/** SHA-256 of each release archive, from the SHA256SUMS file of the release. */
const D2_CHECKSUMS = {
    'linux-amd64': '5669ddc46b99e942cc96078f4a4e36d5e62103348f4c05179ede27802fdd87a9',
    'linux-arm64': 'ac2c028697199479acb321db1e3d68caee9f2ba492ed73caa3cd13f3829bf913',
    'macos-amd64': 'cad39576a480d6bb02ea142fef1726647914b0d2da51ccc9b30b660a2b1babf0',
    'macos-arm64': 'eaf6c0c143e56dd9fa97bfb6df25ea9c1ebce40245f056a0768cf1a6c15d3064',
    'windows-amd64': '5f63b643de8f5a6dfb922d172e1b5496e4caf47497c33c4427cf1127f28c340f',
    'windows-arm64': 'dd05cab459410c287d7ca3eb9cf78145a071742ee8e1b81a0122f84f471883e1',
};

const d2 = process.env.D2 ?? (onPath('d2') ? 'd2' : await downloadD2());
const template = readFileSync(join(root, 'docs/dev-guide/guide.html'), 'utf8');
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

function onPath(command) {
    try {
        execFileSync(command, ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** The path of the pinned d2 release for this platform. Downloads and checks it on first use. */
async function downloadD2() {
    const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
    const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
    const platform = `${os}-${arch}`;
    const checksum = D2_CHECKSUMS[platform];
    if (checksum === undefined) {
        throw new Error(`No pinned d2 release for ${process.platform}-${process.arch}. Install d2 (https://d2lang.com), then put it on the PATH or set D2.`);
    }
    const dir = join(root, 'node_modules/.cache/d2');
    const exe = join(dir, `d2-${D2_VERSION}`, 'bin', os === 'windows' ? 'd2.exe' : 'd2');
    if (existsSync(exe)) {
        return exe;
    }
    const name = `d2-${D2_VERSION}-${platform}.tar.gz`;
    const url = `https://github.com/terrastruct/d2/releases/download/${D2_VERSION}/${name}`;
    console.log(`d2 is not installed. Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Download of ${url} failed: HTTP ${response.status}`);
    }
    const archive = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha256').update(archive).digest('hex');
    if (actual !== checksum) {
        throw new Error(`${name}: the SHA-256 is ${actual}, but the release lists ${checksum}. The file was not used.`);
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), archive);
    // A relative archive path, because GNU tar reads "C:\..." as a remote host.
    execFileSync('tar', ['-xzf', name], { cwd: dir, stdio: 'inherit' });
    rmSync(join(dir, name));
    return exe;
}
