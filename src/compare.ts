/**
 * The diff pipeline for two sets of files: load, build view trees, pair
 * documents, diff. The CLI and library users call {@link compareFiles}.
 */
import { readFile } from 'node:fs/promises';
import { buildReport, diffDocument } from './diff/diff.ts';
import type { DocumentSide } from './diff/diff.ts';
import type { DiffReport } from './diff/report.ts';
import { InputError } from './errors.ts';
import { DocumentStore } from './load/documents.ts';
import { detectVersion } from './load/version.ts';
import { buildDocument } from './model/build.ts';
import { displayPath, pairById } from './sources/files.ts';
import type { SpecFile } from './sources/files.ts';

export interface CompareOptions {
    /** What the base is, for the report header. */
    baseLabel: string;
    /** What the head is, for the report header. */
    headLabel: string;
    /** Folders that messages show file paths relative to. Default: the current folder. */
    cwd?: { base: string; head: string };
}

export interface Comparison {
    report: DiffReport;
    /** OpenAPI documents found on each side. Zero means the patterns selected nothing to compare. */
    documents: { base: number; head: number };
}

export async function compareFiles(base: SpecFile[], head: SpecFile[], options: CompareOptions): Promise<Comparison> {
    const cwd = options.cwd ?? { base: process.cwd(), head: process.cwd() };
    const [baseDocs, headDocs] = await Promise.all([loadDocuments(base, cwd.base), loadDocuments(head, cwd.head)]);
    const documents = pairById(baseDocs, headDocs).map((pair) => diffDocument(pair.id, pair.base, pair.head));
    return {
        report: buildReport(documents, options.baseLabel, options.headLabel),
        documents: { base: baseDocs.length, head: headDocs.length },
    };
}

interface LoadedDocument extends DocumentSide {
    id: string;
    explicit: boolean;
}

/**
 * Load files and keep the OpenAPI documents. A file without an `openapi`
 * field (for example a file of shared schemas) is skipped, unless the user
 * named it directly. One store per side, so shared files parse once.
 */
async function loadDocuments(files: SpecFile[], cwd: string): Promise<LoadedDocument[]> {
    const store = new DocumentStore({ display: (path) => displayPath(path, cwd) });
    const documents: LoadedDocument[] = [];
    for (const file of files) {
        let root: unknown;
        try {
            root = await store.load(file.path);
        } catch (err) {
            // A folder can hold YAML that is not OpenAPI and does not parse (a Helm template). Skip it.
            if (!file.explicit && err instanceof InputError && !(await looksLikeOpenApi(file.path))) {
                continue;
            }
            throw err;
        }
        const version = detectVersion(root, file.display);
        if (version === undefined) {
            if (file.explicit) {
                throw new InputError(`${file.display}: not an OpenAPI document (it has no "openapi" field)`);
            }
            continue;
        }
        await store.loadWithRefs(file.path);
        documents.push({ id: file.id, explicit: file.explicit, display: file.display, model: buildDocument(store, file.path, version) });
    }
    return documents;
}

/** A top-level `openapi` or `swagger` key in the text, found without parsing it. */
async function looksLikeOpenApi(path: string): Promise<boolean> {
    const text = await readFile(path, 'utf8').catch(() => '');
    return /^\s*["']?(openapi|swagger)["']?\s*:/m.test(text) || /"(openapi|swagger)"\s*:/.test(text);
}
