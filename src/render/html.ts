/**
 * HTML renderer: writes the docs model (`docs.ts`) as one self-contained
 * page of API docs, with the changes marked.
 *
 * Parameters and headers show as tables, the request body and responses as
 * blocks, and the schemas below them as schema lines. Each changed endpoint
 * starts with a digest of its changes. A sidebar lists every endpoint by tag,
 * pills count the endpoints per outcome, and a toggle shows all endpoints or
 * only the changed ones.
 *
 * Input documents are untrusted: every string from them goes through
 * `escape()`, `markdown()`, `wordDiff()`, or `styled()`.
 */
import type { AttrChange, DiffReport } from '../diff/report.ts';
import { CSS, SCRIPT } from './html-assets.ts';
import { escape, linesHtml, markdown, toneClass, wordDiff } from './html-text.ts';
import { DIGEST_LIMIT, documentView } from './docs.ts';
import type { BodyView, CallbackView, DigestEntry, DocumentView, EndpointView, PartView, ResponseView, RowView, SchemeView, SecurityView, SectionView, State, TableView, TextView } from './docs.ts';
import { describeChange } from './format.ts';
import { isLongText, MARKERS } from './layout.ts';
import type { Line } from './layout.ts';

export interface HtmlOptions {
    /** Show unchanged endpoints when the page opens. */
    all: boolean;
}

/** Methods with a color of their own. Other methods (3.2 allows any) share one color. */
const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query']);

/** Schemas with more lines than this start folded, unless they changed. */
const FOLD_LINES = 30;

export function renderHtml(report: DiffReport, options: HtmlOptions): string {
    return new HtmlRenderer().render(report, options);
}

class HtmlRenderer {
    /** The ids of the endpoints and documents, for the sidebar links. */
    private readonly ids = new Map<EndpointView, string>();
    private readonly docIds = new Map<DocumentView, string>();

    render(report: DiffReport, options: HtmlOptions): string {
        const docs = report.documents.map((doc) => documentView(doc, true));
        for (const doc of docs) {
            for (const op of [...doc.operations, ...doc.webhooks]) {
                this.ids.set(op, `endpoint-${this.ids.size + 1}`);
            }
        }
        const e = report.endpoints;
        const changed = e.breaking + e.compatible + e.added + e.removed;
        const title = `API changes: ${report.baseLabel} → ${report.headLabel}`;
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${CSS}</style>
</head>
<body class="${options.all ? 'show-all' : ''}">
<header class="top">
  <div class="heading">
    <h1>Comparing <code>${escape(report.baseLabel)}</code> → <code>${escape(report.headLabel)}</code></h1>
    <div class="result ${report.breaking ? 'breaking' : 'ok'}">${report.breaking ? 'Breaking changes found' : 'No breaking changes'}</div>
  </div>
  <div class="bar">
    <div class="pills">
      ${pill('breaking', e.breaking, 'p-breaking', 'Changed endpoints with at least one breaking change')}
      ${pill('added', e.added, 'p-added', 'New endpoints')}
      ${pill('removed', e.removed, 'p-removed', 'Deleted endpoints')}
      ${pill('changed', e.compatible, 'p-changed', 'Changed endpoints with only compatible changes')}
    </div>
    <div class="toggle" role="group" aria-label="Endpoints to show">
      <button type="button" data-show="changed">Changed (${changed})</button><button type="button" data-show="all">All (${changed + e.unchanged})</button>
    </div>
  </div>
</header>
<div class="page">
<nav class="sidebar">
<input class="search" type="search" placeholder="Filter endpoints" aria-label="Filter endpoints">
${docs.map((doc) => this.nav(doc)).join('\n')}
</nav>
<main>
${changed === 0 ? '<p class="empty">No endpoint changed. Select All to see the unchanged endpoints.</p>\n' : ''}${docs.map((doc) => this.document(doc)).join('\n')}
</main>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
    }

    // --- Sidebar -------------------------------------------------------------

    private nav(doc: DocumentView): string {
        const out = [`<div class="nav-doc${hiddenDoc(doc)}"><a class="nav-file" href="#${this.docId(doc)}">${escape(doc.name)}</a>`];
        for (const group of [...byTag(doc.operations), ...(doc.webhooks.length > 0 ? [{ tag: 'Webhooks', ops: doc.webhooks }] : [])]) {
            out.push(`<div class="nav-group${allUnchanged(group.ops)}">`);
            if (group.tag !== undefined) {
                out.push(`<div class="nav-heading">${escape(group.tag)}</div>`);
            }
            const items = group.ops.map((op) => {
                const search = [op.method, op.path, op.operationId ?? '', op.summary.text ?? ''].join(' ').toLowerCase();
                return [
                    `<li class="${toneClass(op.state.tone)} ${op.outcome}" data-search="${escape(search)}">`,
                    `<a href="#${this.ids.get(op)}" title="${escape(op.summary.text ?? op.path)}">`,
                    `<span class="marker">${MARKERS[op.state.status].trim()}</span>`,
                    methodChip(op.method),
                    `<span class="path">${escape(op.path)}</span></a></li>`,
                ].join('');
            });
            out.push(`<ul>${items.join('')}</ul></div>`);
        }
        out.push('</div>');
        return out.join('\n');
    }

    // --- Documents -----------------------------------------------------------

    private document(doc: DocumentView): string {
        const title = doc.diff.info.attrs.title;
        const version = doc.diff.info.attrs.version;
        const out = [
            `<section class="doc${hiddenDoc(doc)}" id="${this.docId(doc)}">`,
            `<header class="doc-head ${toneClass(doc.state.tone)}">`,
            `<h2>${escape(title ?? doc.name)}${version === undefined ? '' : ` <span class="version">${escape(version)}</span>`}</h2>`,
            `<div class="doc-file"><code>${escape(doc.name)}</code>${doc.note === '' ? '' : ` <span class="tag ${toneClass(doc.state.tone)}">${escape(doc.note.trim().replace(/[()]/g, ''))}</span>`}</div>`,
            textHtml(doc.description, 'description'),
            changeList(doc.changes),
            ...doc.warnings.map((text) => `<p class="warning">Warning: ${escape(text)}</p>`),
            '</header>',
        ];
        for (const group of byTag(doc.operations)) {
            if (group.tag !== undefined) {
                out.push(`<h3 class="tag-heading${allUnchanged(group.ops)}">${escape(group.tag)}</h3>`);
            }
            out.push(...group.ops.map((op) => this.endpoint(op)));
        }
        if (doc.webhooks.length > 0) {
            out.push(`<h3 class="tag-heading${allUnchanged(doc.webhooks)}">Webhooks</h3>`, ...doc.webhooks.map((op) => this.endpoint(op)));
        }
        out.push('</section>');
        return out.join('\n');
    }

    private docId(doc: DocumentView): string {
        let id = this.docIds.get(doc);
        if (id === undefined) {
            id = `doc-${this.docIds.size + 1}`;
            this.docIds.set(doc, id);
        }
        return id;
    }

    // --- Endpoints -----------------------------------------------------------

    /** One endpoint as a card. A callback's endpoints nest inside the card of their endpoint. */
    private endpoint(op: EndpointView): string {
        const id = this.ids.get(op);
        const tags = op.changes.find((change) => change.name === 'tags');
        const meta = [
            op.operationId === undefined ? '' : `<span>Operation ID <code>${escape(op.operationId)}</code></span>`,
            op.servers.length === 0 ? '' : `<span>Servers ${op.servers.map((server) => `<code>${escape(server)}</code>`).join(' ')}</span>`,
        ].filter(Boolean);
        const out = [
            `<article class="endpoint ${op.outcome} ${toneClass(op.state.tone)}"${id === undefined ? '' : ` id="${id}"`}>`,
            '<header class="ep-head">',
            `<div class="ep-line">${methodChip(op.method)}<code class="ep-path">${pathHtml(op.path)}</code>`,
            op.deprecated ? '<span class="tag">deprecated</span>' : '',
            op.badge === '' ? '' : `<span class="badge ${toneClass(op.state.tone)}">${escape(op.badge.replace(/^\[|\]$/g, ''))}</span>`,
            '</div>',
            op.summary.text === undefined && op.summary.change === undefined ? '' : `<div class="ep-title">${op.summary.change === undefined ? escape(op.summary.text ?? '') : wordDiff(str(op.summary.change.before), str(op.summary.change.after))}</div>`,
            tags === undefined ? tagChips(op.tags) : listDiff(tags),
            meta.length === 0 ? '' : `<div class="ep-meta">${meta.join('')}</div>`,
            '</header>',
            banner(op),
            digestHtml(op.digest),
            // A callback's endpoint has no digest: its changes show here, and in the digest of its endpoint.
            op.digest.length === 0 ? changeList(op.changes.filter((change) => change.name !== 'tags')) : '',
            textHtml(op.description, 'description'),
            ...op.sections.map((section) => this.section(section)),
            '</article>',
        ];
        return out.filter(Boolean).join('\n');
    }

    private section(section: SectionView): string {
        const title = section.key === 'security' ? 'Authorization' : section.title;
        return [`<section class="ep-section ${statusClass(section.state)}">`, `<h4>${escape(title)}${stateTag(section.state)}</h4>`, ...section.parts.map((part) => this.part(part)), '</section>'].join('\n');
    }

    private part(part: PartView): string {
        switch (part.kind) {
            case 'table':
                return table(part);
            case 'security':
                return security(part);
            case 'body':
                return body(part);
            case 'response':
                return response(part);
            case 'callback':
                return this.callback(part);
        }
    }

    private callback(callback: CallbackView): string {
        return [
            `<div class="callback ${statusClass(callback.state)}">`,
            `<h5>Callback <code>${escape(callback.name)}</code>${stateTag(callback.state)}</h5>`,
            ...callback.endpoints.map((op) => this.endpoint(op)),
            '</div>',
        ].join('\n');
    }
}

// --- Parts -------------------------------------------------------------------

function table(part: TableView): string {
    const rows = part.rows.map((row) => {
        const flags = [
            row.facts.includes('required') ? '<span class="required">required</span>' : '',
            row.facts.includes('deprecated') ? '<span class="tag">deprecated</span>' : '',
        ].join('');
        const out = [
            `<tr class="row ${statusClass(row.state)}">`,
            `<td class="p-name"><code>${escape(row.name)}</code>${flags}${stateTag(row.state)}</td>`,
            `<td class="p-type">${typeHtml(row)}</td>`,
            `<td class="p-desc">${rowText(row)}</td>`,
            '</tr>',
        ];
        if (row.schema.length > 0) {
            out.push(`<tr class="sub ${statusClass(row.state)}"><td colspan="3">${schemaHtml(row.schema, row.state)}</td></tr>`);
        }
        return out.join('');
    });
    return [
        part.title === '' ? '' : `<h5>${escape(part.title)}${stateTag(part.state)}</h5>`,
        '<div class="table-wrap"><table class="params"><colgroup><col class="c-name"><col class="c-type"><col></colgroup><thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead>',
        `<tbody>${rows.join('')}</tbody></table></div>`,
    ].join('');
}

function security(part: SecurityView): string {
    const requirements = part.requirements.map((requirement) => {
        const [first] = requirement.schemes;
        const schemes = requirement.schemes.length === 1 && first.name === requirement.label ? [{ ...first, state: requirement.state }] : requirement.schemes;
        const joined = schemes.map((scheme) => schemeHtml(scheme)).join('<div class="and">and</div>');
        const tag = schemes === requirement.schemes ? stateTag(requirement.state) : '';
        return `<li class="${statusClass(requirement.state)}">${tag}${joined}</li>`;
    });
    return `<ul class="auth">${requirements.join('<li class="or">or</li>')}</ul>`;
}

function schemeHtml(scheme: SchemeView): string {
    const flows = scheme.flows.map(
        (flow) => `<li class="${statusClass(flow.state)}"><code>${escape(flow.name)}</code> <span class="dim">${escape(flow.label)}</span>${stateTag(flow.state)}${changeList(flow.changes)}</li>`,
    );
    return [
        `<div class="scheme ${statusClass(scheme.state)}">`,
        `<div><code>${escape(scheme.name)}</code> <span class="type">${escape(scheme.label)}</span>${stateTag(scheme.state)}</div>`,
        textHtml(scheme.description, 'description'),
        changeList(scheme.changes),
        flows.length === 0 ? '' : `<ul class="flows">${flows.join('')}</ul>`,
        '</div>',
    ].join('');
}

function body(part: BodyView): string {
    return [
        `<div class="block ${statusClass(part.state)}">`,
        `<h5>Body${part.required ? ' <span class="required">required</span>' : ''}${stateTag(part.state)}</h5>`,
        textHtml(part.description, 'description'),
        changeList(part.changes),
        ...part.media.map((row) => media(row)),
        '</div>',
    ].join('\n');
}

function response(part: ResponseView): string {
    // A short one-line description reads as the title of the response.
    const description = part.description;
    const inlineDescription = part.summary.text === undefined && description.change === undefined && description.text !== undefined && !isLongText(description.text);
    const title = part.summary.change !== undefined ? wordDiff(str(part.summary.change.before), str(part.summary.change.after)) : escape(part.summary.text ?? (inlineDescription ? (description.text ?? '') : ''));
    return [
        `<div class="block response ${statusClass(part.state)}">`,
        `<div class="resp-head"><span class="code c-${codeClass(part.code)}">${escape(part.code)}</span><span class="resp-title">${title}</span>${stateTag(part.state)}</div>`,
        inlineDescription ? '' : textHtml(description, 'description'),
        changeList(part.changes),
        part.headers === undefined ? '' : table(part.headers),
        ...part.media.map((row) => media(row)),
        '</div>',
    ].join('\n');
}

/** A media type of a body or response, with its schema. */
function media(row: RowView): string {
    return [
        `<div class="media ${statusClass(row.state)}">`,
        `<div class="media-head"><code>${escape(row.name)}</code> ${typeHtml(row)}${stateTag(row.state)}</div>`,
        rowText(row),
        row.schema.length === 0 ? '' : schemaHtml(row.schema, row.state),
        '</div>',
    ].join('\n');
}

// --- Pieces ------------------------------------------------------------------

/** The type label and badges of a row. `required` and `deprecated` show elsewhere. */
function typeHtml(row: RowView): string {
    const facts = row.facts.filter((fact) => fact !== 'required' && fact !== 'deprecated');
    const stop = row.stop === undefined ? '' : ` <span class="dim">(${escape(row.stop)})</span>`;
    return `<span class="type">${escape(row.type)}</span>${stop}${facts.map((fact) => ` <span class="fact">${escape(fact)}</span>`).join('')}`;
}

/** The description, details, and changes of a row. */
function rowText(row: RowView): string {
    return [textHtml(row.description, 'description'), ...row.details.map((detail) => `<div class="detail">${escape(detail)}</div>`), changeList(row.changes)].join('');
}

/** A schema's lines. A long schema that did not change starts folded. */
function schemaHtml(lines: Line[], state: State): string {
    const changed = state.status !== 'unchanged' || lines.some((line) => line.tone !== undefined);
    if (lines.length > FOLD_LINES && !changed) {
        return `<details class="schema"><summary>Schema: ${lines.length} lines</summary>${linesHtml(lines)}</details>`;
    }
    return `<div class="schema">${linesHtml(lines)}</div>`;
}

/** Free text as Markdown. When it changed, a word diff of the source text follows, folded. */
function textHtml(text: TextView, name: string): string {
    const current = text.text === undefined ? '' : `<div class="md">${markdown(text.text)}</div>`;
    const change = text.change;
    if (change === undefined) {
        return current;
    }
    const tone = toneClass(change.severity === 'breaking' ? 'breaking' : 'changed');
    const removed = change.after === undefined ? ' (removed)' : '';
    return `${current}<details class="text-diff ${tone}"><summary>${escape(name)} changed${removed}${reasonHtml(change)}</summary><div class="diff">${wordDiff(str(change.before), str(change.after))}</div></details>`;
}

/** Changes of a part's own facts, one per line. */
function changeList(changes: AttrChange[]): string {
    if (changes.length === 0) {
        return '';
    }
    const items = changes.map((change) => {
        const tone = change.severity === 'breaking' ? 'breaking' : 'changed';
        const text = isLongText(change.before) || isLongText(change.after) ? `${escape(change.name)}: ${wordDiff(str(change.before), str(change.after))}` : escape(describeChange(change));
        return `<li class="${toneClass(tone)}"><span class="marker">~</span><span>${text}${reasonHtml(change)}</span></li>`;
    });
    return `<ul class="changes">${items.join('')}</ul>`;
}

function reasonHtml(verdict: { severity?: string; reason?: string }): string {
    return verdict.severity === 'breaking' && verdict.reason !== undefined ? ` <span class="reason">breaking: ${escape(verdict.reason)}</span>` : '';
}

/** The digest of a changed endpoint: every change with where it is. */
function digestHtml(entries: DigestEntry[]): string {
    if (entries.length === 0) {
        return '';
    }
    const breaking = entries.filter((entry) => entry.tone === 'breaking').length;
    const items = entries.slice(0, DIGEST_LIMIT).map(
        (entry) =>
            `<li class="${toneClass(entry.tone)}"><span class="marker">${MARKERS[entry.status]}</span><span>${entry.where === '' ? '' : `<span class="where">${escape(entry.where)}</span> `}<span class="what">${escape(entry.text)}</span>${entry.reason === undefined ? '' : ` <span class="reason">breaking: ${escape(entry.reason)}</span>`}</span></li>`,
    );
    if (entries.length > DIGEST_LIMIT) {
        items.push(`<li class="t-none"><span class="marker"></span><span class="dim">… ${entries.length - DIGEST_LIMIT} more</span></li>`);
    }
    const count = `${entries.length} ${entries.length === 1 ? 'change' : 'changes'}${breaking > 0 ? `, ${breaking} breaking` : ''}`;
    return `<div class="digest"><div class="digest-title">What changed <span class="dim">${count}</span></div><ul>${items.join('')}</ul></div>`;
}

/** The banner of an added or removed endpoint. */
function banner(op: EndpointView): string {
    if (op.outcome !== 'added' && op.outcome !== 'removed') {
        return '';
    }
    const text = op.outcome === 'added' ? 'New endpoint.' : 'This endpoint was removed.';
    return `<div class="banner ${toneClass(op.state.tone)}">${text}${reasonHtml(op.state)}</div>`;
}

/** A small tag that says a part was added, removed, or changed. */
function stateTag(state: State): string {
    if (state.status === 'unchanged') {
        return '';
    }
    const label = state.status === 'changed' ? 'changed' : state.status;
    const reason = state.status !== 'changed' && state.reason !== undefined ? state.reason : undefined;
    const text = state.severity === 'breaking' && reason !== undefined ? `${label}, breaking: ${reason}` : label;
    return ` <span class="tag state-tag ${toneClass(state.tone)}"${reason === undefined ? '' : ` title="${escape(reason)}"`}>${escape(text)}</span>`;
}

function statusClass(state: State): string {
    return `st-${state.status} ${toneClass(state.tone)}`;
}

function tagChips(tags: string[]): string {
    return tags.length === 0 ? '' : `<div class="chips">${tags.map((tag) => `<span class="chip">${escape(tag)}</span>`).join('')}</div>`;
}

/** A list attribute that changed (tags): the kept values, the added ones, and the removed ones. */
function listDiff(change: AttrChange): string {
    const before = Array.isArray(change.before) ? change.before.map(String) : [];
    const after = Array.isArray(change.after) ? change.after.map(String) : [];
    const chips = [
        ...after.map((value) => `<span class="chip${before.includes(value) ? '' : ' chip-added'}">${escape(value)}</span>`),
        ...before.filter((value) => !after.includes(value)).map((value) => `<span class="chip chip-removed">${escape(value)}</span>`),
    ];
    return `<div class="chips">${chips.join('')}</div>`;
}

function methodChip(method: string): string {
    const name = method.toLowerCase();
    return `<span class="method m-${METHODS.has(name) ? name : 'other'}">${escape(method)}</span>`;
}

/** The path with its `{parameters}` marked. */
function pathHtml(path: string): string {
    return escape(path).replace(/\{[^}]+\}/g, (param) => `<span class="path-param">${param}</span>`);
}

function codeClass(code: string): string {
    return /^[1-5]/.test(code) ? `${code[0]}xx` : 'default';
}

function pill(label: string, count: number, css: string, title: string): string {
    return `<span class="pill ${css}${count === 0 ? ' zero' : ''}" title="${title}"><b>${count}</b> ${label}</span>`;
}

/** Endpoints grouped by their first tag, in order of first use. No tags at all: one group without a heading. */
function byTag(ops: EndpointView[]): { tag?: string; ops: EndpointView[] }[] {
    if (ops.every((op) => op.tags.length === 0)) {
        return ops.length === 0 ? [] : [{ ops }];
    }
    const groups = new Map<string, EndpointView[]>();
    for (const op of ops) {
        const tag = op.tags[0] ?? 'Other';
        groups.set(tag, [...(groups.get(tag) ?? []), op]);
    }
    return [...groups].map(([tag, list]) => ({ tag, ops: list }));
}

/** ` unchanged` when no endpoint in the list changed, so the part hides with the unchanged endpoints. */
function allUnchanged(ops: EndpointView[]): string {
    return ops.every((op) => op.outcome === 'unchanged') ? ' unchanged' : '';
}

/** An unchanged document hides with the unchanged endpoints, unless it has warnings: part of it was not compared. */
function hiddenDoc(doc: DocumentView): string {
    return doc.state.status === 'unchanged' && doc.warnings.length === 0 ? ' unchanged' : '';
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}
