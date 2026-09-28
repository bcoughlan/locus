/**
 * The docs model: each endpoint of a diff report as API docs, with the
 * changes marked. Both renderers paint it: the console as indented text,
 * the HTML renderer as a docs page.
 *
 * Parameters and headers become table rows, the request body and the
 * responses become blocks, and the schemas below them become schema lines
 * (`layout.ts`). A digest lists every change of an endpoint in one place.
 */
import { endpointOutcome } from '../diff/report.ts';
import type { AttrChange, ChangeStatus, DiffNode, DocumentDiff, EndpointOutcome, Severity } from '../diff/report.ts';
import type { AttrName } from '../model/tree.ts';
import { badges, changeDistances, describeChange, details, flowLabel, schemeLabel, show, typeLabel } from './format.ts';
import type { Definitions } from './format.ts';
import { breakingTag, endpointBadge, endpointStatus, endpointTone, rowState, SchemaLayout, toneOf } from './layout.ts';
import type { Line, StopReason } from './layout.ts';
import type { Tone } from './text.ts';

// --- Model -------------------------------------------------------------------

/** How a part changed. `reason` is the verdict of an added or removed part. */
export interface State {
    status: ChangeStatus;
    tone?: Tone;
    severity?: Severity;
    reason?: string;
}

/** Free text (summary, description) with its change, when it changed. */
export interface TextView {
    text?: string;
    change?: AttrChange;
}

export interface RowView {
    node: DiffNode;
    name: string;
    state: State;
    /** A type label, such as `integer<int32>`. */
    type: string;
    /** Why the type's reference does not expand here, in a large endpoint. */
    stop?: StopReason;
    /** Badges, such as `required` and `<= 100`. */
    facts: string[];
    description: TextView;
    /** Detail lines, such as `Allowed values: a, b`. */
    details: string[];
    /** Changes of the node's own facts, without the description. */
    changes: AttrChange[];
    /** The schema below the row. */
    schema: Line[];
}

/** Parameters of one location, or the headers of a response. */
export interface TableView {
    kind: 'table';
    title: string;
    state: State;
    rows: RowView[];
}

export interface SchemeView {
    name: string;
    state: State;
    label: string;
    description: TextView;
    flows: { name: string; state: State; label: string; changes: AttrChange[] }[];
    changes: AttrChange[];
}

/** One way to authorize: one or more schemes that apply together. */
export interface RequirementView {
    label: string;
    state: State;
    schemes: SchemeView[];
}

export interface SecurityView {
    kind: 'security';
    state: State;
    requirements: RequirementView[];
}

export interface BodyView {
    kind: 'body';
    state: State;
    required: boolean;
    description: TextView;
    changes: AttrChange[];
    /** One row per media type. */
    media: RowView[];
}

export interface ResponseView {
    kind: 'response';
    code: string;
    state: State;
    summary: TextView;
    description: TextView;
    changes: AttrChange[];
    headers?: TableView;
    media: RowView[];
}

export interface CallbackView {
    kind: 'callback';
    name: string;
    state: State;
    endpoints: EndpointView[];
}

export type PartView = TableView | SecurityView | BodyView | ResponseView | CallbackView;

export interface SectionView {
    /** `security`, `request`, `responses`, or `callbacks`. */
    key: string;
    title: string;
    state: State;
    parts: PartView[];
}

/** One entry of the change digest. */
export interface DigestEntry {
    /** Where the change is, for example `query parameter limit` or `response 200 › application/json › owner.name`. Empty: the endpoint itself. */
    where: string;
    status: 'added' | 'removed' | 'changed';
    /** `added`, `removed`, or the change, for example `maximum: 500 → 100`. */
    text: string;
    tone: Tone;
    /** The breaking reason. */
    reason?: string;
}

export interface EndpointView {
    node: DiffNode;
    outcome: EndpointOutcome;
    state: State;
    /** `[breaking]`, `[added]`, ... Empty when unchanged. */
    badge: string;
    method: string;
    path: string;
    operationId?: string;
    deprecated: boolean;
    summary: TextView;
    description: TextView;
    tags: string[];
    servers: string[];
    /** Changes of the endpoint's own facts, without summary and description. */
    changes: AttrChange[];
    digest: DigestEntry[];
    sections: SectionView[];
}

export interface DocumentView {
    diff: DocumentDiff;
    name: string;
    state: State;
    /** ` (new file)`, ` (deleted)`, or empty. */
    note: string;
    title: string;
    description: TextView;
    changes: AttrChange[];
    warnings: string[];
    operations: EndpointView[];
    webhooks: EndpointView[];
}

// --- Building ----------------------------------------------------------------

/** The docs model of one document diff. `all`: also the unchanged endpoints. */
export function documentView(doc: DocumentDiff, all: boolean): DocumentView {
    const builder = new DocsBuilder(doc.schemas);
    const shown = (list: DiffNode[]) => list.filter((op) => all || endpointOutcome(op) !== 'unchanged');
    const info = doc.info;
    return {
        diff: doc,
        name: doc.head ?? doc.base ?? doc.id,
        state: { status: doc.status, tone: toneOf(doc.status, doc.impact), severity: doc.impact },
        note: doc.status === 'added' ? ' (new file)' : doc.status === 'removed' ? ' (deleted)' : '',
        title: [info.attrs.title, info.attrs.version].filter(Boolean).join(' '),
        description: textView(info, 'description'),
        changes: info.changes.filter((change) => change.name !== 'description'),
        warnings: doc.warnings,
        operations: shown(doc.operations).map((op) => builder.endpoint(op)),
        webhooks: shown(doc.webhooks).map((op) => builder.endpoint(op)),
    };
}

class DocsBuilder {
    private readonly layout: SchemaLayout;
    private readonly definitions: Definitions;
    private readonly distances: Map<string, number>;

    constructor(schemas: Record<string, DiffNode>) {
        this.layout = new SchemaLayout(schemas);
        this.definitions = (id) => schemas[id];
        this.distances = changeDistances(schemas);
    }

    endpoint(op: DiffNode, nested = false): EndpointView {
        if (!nested) {
            this.layout.startEndpoint();
        }
        const a = op.attrs;
        const status = endpointStatus(op);
        return {
            node: op,
            outcome: endpointOutcome(op),
            state: { status, tone: endpointTone(op), severity: status === 'changed' ? op.impact : op.verdict?.severity, reason: op.verdict?.reason },
            badge: endpointBadge(op),
            method: a.method ?? '',
            path: a.path ?? op.label,
            operationId: a.operationId,
            deprecated: a.deprecated === true,
            summary: textView(op, 'summary'),
            description: textView(op, 'description'),
            tags: a.tags ?? [],
            servers: a.servers ?? [],
            changes: op.changes.filter((change) => change.name !== 'summary' && change.name !== 'description'),
            digest: status === 'changed' && !nested ? digest(op, this.definitions, this.distances) : [],
            sections: op.children.map((section) => this.section(section)),
        };
    }

    private section(node: DiffNode): SectionView {
        const parts: PartView[] = [];
        if (node.key === 'security') {
            parts.push({ kind: 'security', state: stateOf(node), requirements: node.children.map((child) => this.requirement(child)) });
        }
        for (const child of node.key === 'security' ? [] : node.children) {
            switch (child.kind) {
                case 'group':
                    parts.push(this.table(child));
                    break;
                case 'requestBody':
                    parts.push({
                        kind: 'body',
                        state: stateOf(child),
                        required: child.attrs.required === true,
                        description: textView(child, 'description'),
                        changes: withoutDescription(child.changes),
                        media: child.children.map((media) => this.row(media)),
                    });
                    break;
                case 'response':
                    parts.push(this.response(child));
                    break;
                case 'callback':
                    parts.push({ kind: 'callback', name: child.label, state: stateOf(child), endpoints: child.children.map((op) => this.endpoint(op, true)) });
                    break;
                default:
                    // Sections hold only the kinds above. A new kind shows as a table row.
                    parts.push({ kind: 'table', title: '', state: stateOf(child), rows: [this.row(child)] });
            }
        }
        return { key: node.key, title: node.label, state: stateOf(node), parts };
    }

    private table(group: DiffNode): TableView {
        return { kind: 'table', title: group.label, state: stateOf(group), rows: group.children.map((child) => this.row(child)) };
    }

    private response(node: DiffNode): ResponseView {
        const headers = node.children.find((child) => child.kind === 'group');
        return {
            kind: 'response',
            code: node.label,
            state: stateOf(node),
            summary: textView(node, 'summary'),
            description: textView(node, 'description'),
            changes: node.changes.filter((change) => change.name !== 'summary' && change.name !== 'description'),
            headers: headers === undefined ? undefined : this.table(headers),
            media: node.children.filter((child) => child !== headers).map((media) => this.row(media)),
        };
    }

    /** A parameter, header, or media type: a node that holds a schema. */
    private row(node: DiffNode): RowView {
        const shown = show(node, this.definitions);
        const { status, severity } = rowState(node, this.definitions);
        const { stop, lines } = this.layout.schemaBody(node);
        return {
            node,
            name: node.label,
            state: { status, severity, tone: toneOf(status, severity), reason: node.verdict?.reason },
            type: typeLabel(node, this.definitions),
            stop,
            facts: badges(shown.attrs),
            description: { text: shown.attrs.description, change: shown.changes.find((change) => change.name === 'description') },
            details: details(shown.attrs),
            changes: withoutDescription(shown.changes),
            schema: lines,
        };
    }

    /** A requirement with a single scheme shows as that scheme, with the requirement's verdict. */
    private requirement(node: DiffNode): RequirementView {
        const single = node.children.length === 1 && node.children[0].key === node.key;
        const state = single && node.verdict === undefined ? stateOf(node.children[0]) : stateOf(node);
        return { label: node.label, state, schemes: node.children.map((scheme) => this.scheme(scheme)) };
    }

    private scheme(node: DiffNode): SchemeView {
        return {
            name: node.label,
            state: stateOf(node),
            label: schemeLabel(node.attrs),
            description: textView(node, 'description'),
            flows: node.children.map((flow) => ({ name: flow.label, state: stateOf(flow), label: flowLabel(flow.attrs), changes: flow.changes })),
            changes: withoutDescription(node.changes),
        };
    }
}

function stateOf(node: DiffNode): State {
    return { status: node.status, tone: toneOf(node.status, node.verdict?.severity), severity: node.verdict?.severity, reason: node.verdict?.reason };
}

function textView(node: DiffNode, attr: AttrName): TextView {
    const value = node.attrs[attr];
    return { text: typeof value === 'string' ? value : undefined, change: node.changes.find((change) => change.name === attr) };
}

function withoutDescription(changes: AttrChange[]): AttrChange[] {
    return changes.filter((change) => change.name !== 'description');
}

// --- Digest ------------------------------------------------------------------

/** Renderers show at most this many digest entries per endpoint. The docs below still show every change. */
export const DIGEST_LIMIT = 50;

/**
 * Every change of an endpoint, with where it is. A referenced definition
 * counts once per endpoint, under the first place that reaches it, and only
 * when a change is in reach.
 */
export function digest(op: DiffNode, definitions: Definitions, distances: Map<string, number>): DigestEntry[] {
    const entries: DigestEntry[] = [];
    const visited = new Set<string>();
    const add = (where: Crumb[], change: AttrChange) =>
        entries.push({
            where: joinWhere(where),
            status: 'changed',
            // Free text is too long for one line. The docs show old and new.
            text: change.name === 'description' || change.name === 'summary' ? `${change.name} changed` : describeChange(change),
            tone: change.severity === 'breaking' ? 'breaking' : 'changed',
            reason: change.severity === 'breaking' ? change.reason : undefined,
        });

    /** `inherited`: the reason of an added or removed section or group above, which has no place of its own. */
    const visit = (node: DiffNode, where: Crumb[], inherited?: string): void => {
        const steps = crumb(node);
        const here = [...where, ...steps];
        if (node.status === 'added' || node.status === 'removed') {
            const reason = node.verdict?.reason ?? inherited;
            if (steps.length === 0 && node.children.length > 0) {
                // A section or group: its children name the places.
                node.children.forEach((child) => visit(child, here, reason));
                return;
            }
            const severity = node.verdict?.severity;
            entries.push({
                where: joinWhere(here),
                status: node.status,
                text: node.status,
                tone: toneOf(node.status, severity)!,
                reason: severity === 'breaking' ? reason : undefined,
            });
            return;
        }
        let changes = node.changes;
        let children = node.children;
        if (node.ref !== undefined && !visited.has(node.ref) && distances.has(node.ref)) {
            visited.add(node.ref);
            const shown = show(node, definitions);
            changes = shown.changes;
            children = shown.children;
        }
        for (const change of changes) {
            add(here, change);
        }
        children.forEach((child) => visit(child, here));
    };

    for (const change of op.changes) {
        add([], change);
    }
    op.children.forEach((child) => visit(child, []));
    return entries;
}

/** A step of a digest place. Schema steps (`schema: true`) join with dots: `owner.address.zip`. */
interface Crumb {
    text: string;
    schema?: boolean;
}

function crumb(node: DiffNode): Crumb[] {
    switch (node.kind) {
        case 'section':
            return node.key === 'security' ? [{ text: 'security' }] : [];
        case 'group':
            return [];
        case 'parameter':
            return [{ text: `${node.attrs.in ?? ''} parameter ${node.label}`.trim() }];
        case 'header':
            return [{ text: `header ${node.label}` }];
        case 'requestBody':
            return [{ text: 'request body' }];
        case 'response':
            return [{ text: `response ${node.label}` }];
        case 'callback':
            return [{ text: `callback ${node.label}` }];
        case 'securityRequirement':
            return [{ text: node.label }];
        case 'securityScheme':
            return [{ text: node.label }];
        case 'oauthFlow':
            return [{ text: `${node.label} flow` }];
        case 'items':
            return [{ text: node.key === '[]' ? '[]' : node.label, schema: true }];
        case 'mediaType':
        case 'operation':
            return [{ text: node.label }];
        default:
            return [{ text: node.label, schema: true }];
    }
}

function joinWhere(crumbs: Crumb[]): string {
    let out = '';
    crumbs.forEach((step, i) => {
        const previous = crumbs[i - 1];
        // The same scheme under its single-scheme requirement: one step.
        if (previous !== undefined && previous.text === step.text) {
            return;
        }
        if (i === 0) {
            out = step.text;
        } else if (step.schema && previous.schema) {
            out += step.text === '[]' ? '[]' : `.${step.text}`;
        } else {
            out += ` › ${step.text}`;
        }
    });
    return out;
}

/** The digest entry as one line of text, for example `query parameter limit: added  [breaking: …]`. */
export function digestText(entry: DigestEntry): string {
    const tag = breakingTag(entry.reason === undefined ? undefined : { severity: 'breaking', reason: entry.reason });
    return `${entry.where === '' ? '' : `${entry.where}: `}${entry.text}${tag}`;
}
