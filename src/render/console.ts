/**
 * Console renderer: prints a diff report as indented text, like API docs.
 *
 * Each line starts with a marker column, as in a unified diff: `+` added,
 * `-` removed, `~` changed, blank for unchanged. Colors repeat the markers:
 * green for additions, orange for compatible changes, red for breaking
 * changes. Breaking changes also carry a `[breaking: reason]` tag, so the
 * output keeps all information without color.
 */
import { Chalk } from 'chalk';
import type { ChalkInstance, ColorSupportLevel } from 'chalk';
import { endpointOutcome } from '../diff/report.ts';
import type { AttrChange, ChangeStatus, DiffNode, DiffReport, DocumentDiff, Severity } from '../diff/report.ts';
import type { AttrName } from '../model/tree.ts';
import { badges, describeChange, details, flowLabel, inlineItems, schemeLabel, typeLabel } from './format.ts';

/** Chalk color levels: 0 none, 1 basic 16 colors, 2 256 colors, 3 truecolor. */
export type ColorLevel = ColorSupportLevel;

export interface ConsoleOptions {
    color: ColorLevel;
    /** Print unchanged documents and endpoints too. */
    all: boolean;
}

/** What a line means, which selects its marker and color. */
type Tone = 'added' | 'breaking' | 'changed' | undefined;

const MARKERS: Record<ChangeStatus, string> = { added: '+', removed: '-', changed: '~', unchanged: ' ' };

export function renderConsole(report: DiffReport, options: ConsoleOptions): string {
    return new ConsoleRenderer(options).render(report);
}

class ConsoleRenderer {
    private readonly lines: string[] = [];
    private readonly c: ChalkInstance;
    private readonly orange: ChalkInstance;
    private readonly options: ConsoleOptions;

    constructor(options: ConsoleOptions) {
        this.options = options;
        this.c = new Chalk({ level: options.color });
        this.orange = this.c.hex('#FFA500');
    }

    render(report: DiffReport): string {
        this.lines.push(this.c.bold(`Comparing ${report.baseLabel} → ${report.headLabel}`), '');
        // An unchanged document still shows when it has warnings: part of it was not compared.
        const shown = report.documents.filter((doc) => this.options.all || doc.status !== 'unchanged' || doc.warnings.length > 0);
        for (const doc of shown) {
            this.document(doc);
        }
        this.summary(report);
        return `${this.lines.join('\n')}\n`;
    }

    // --- Documents and endpoints ---------------------------------------------

    private document(doc: DocumentDiff): void {
        const tone = toneOf(doc.status, doc.impact);
        const name = doc.head ?? doc.base ?? doc.id;
        const note = doc.status === 'added' ? ' (new file)' : doc.status === 'removed' ? ' (deleted)' : '';
        const title = [doc.info.attrs.title, doc.info.attrs.version].filter(Boolean).join(' ');
        this.line(MARKERS[doc.status], 0, `${this.paint(tone, this.c.bold(name + note))}  ${this.c.dim(title)}`, tone);
        this.changes(doc.info.changes, 1);
        for (const warning of doc.warnings) {
            this.line(' ', 1, this.c.magenta(`warning: ${warning}`));
        }
        this.lines.push('');

        const shown = (list: DiffNode[]) => list.filter((op) => this.options.all || endpointOutcome(op) !== 'unchanged');
        this.children(shown(doc.operations), 1);
        const webhooks = shown(doc.webhooks);
        if (webhooks.length > 0) {
            this.line(' ', 1, this.c.bold('Webhooks'));
            this.lines.push('');
            this.children(webhooks, 1);
        }
    }

    private operation(op: DiffNode, depth: number): void {
        const outcome = endpointOutcome(op);
        const status: ChangeStatus = outcome === 'added' || outcome === 'removed' ? outcome : outcome === 'unchanged' ? 'unchanged' : 'changed';
        // The header shows the endpoint as a whole: its own verdict when added or removed, else the worst change inside.
        const tone = toneOf(status, status === 'changed' ? op.impact : op.verdict?.severity);
        const a = op.attrs;
        const parts = [this.paint(tone, this.c.bold(`${a.method} ${a.path}`))];
        if (a.operationId !== undefined) {
            parts.push(this.c.dim(a.operationId));
        }
        if (a.deprecated) {
            parts.push(this.c.dim('deprecated'));
        }
        parts.push(this.paint(tone, badge(op)));
        this.line(MARKERS[status], depth, parts.filter(Boolean).join('  '), tone);

        const inner = depth + 1;
        this.text(a.summary, op, inner, 'summary', false);
        this.text(a.description, op, inner, 'description');
        if (a.tags !== undefined && !changed(op, 'tags')) {
            this.detail(op, inner, this.c.dim(`Tags: ${a.tags.join(', ')}`));
        }
        if (a.servers !== undefined && !changed(op, 'servers')) {
            this.detail(op, inner, this.c.dim(`Servers: ${a.servers.join(', ')}`));
        }
        this.changes(op.changes, inner);
        this.children(op.children, inner);
        // A blank line ends each endpoint. Operations inside a callback belong to their endpoint.
        if (depth === 1) {
            this.lines.push('');
        }
    }

    // --- Nodes ---------------------------------------------------------------

    private node(node: DiffNode, depth: number): void {
        const inner = depth + 1;
        switch (node.kind) {
            case 'operation':
                this.operation(node, depth);
                return;
            case 'section':
            case 'group':
            case 'callback':
                this.row(node, depth, node.kind === 'group' ? node.label : this.c.bold(node.label));
                break;
            case 'securityRequirement':
                // A requirement with a single scheme prints as that scheme's line.
                if (node.children.length === 1 && node.children[0].key === node.key) {
                    this.node({ ...node.children[0], verdict: node.verdict ?? node.children[0].verdict }, depth);
                    return;
                }
                this.row(node, depth, node.label);
                break;
            case 'securityScheme':
                this.row(node, depth, `${node.label}  ${schemeLabel(node.attrs)}`);
                this.text(node.attrs.description, node, inner, 'description');
                break;
            case 'oauthFlow':
                this.row(node, depth, `${node.label}  ${this.c.dim(flowLabel(node.attrs))}`);
                break;
            case 'response':
                this.response(node, depth);
                break;
            case 'requestBody':
                this.row(node, depth, node.attrs.required ? 'Body  required' : 'Body');
                this.text(node.attrs.description, node, inner, 'description');
                break;
            default:
                this.schema(node, depth);
                return;
        }
        this.changes(node.changes, inner);
        this.children(node.children, inner);
    }

    private children(nodes: DiffNode[], depth: number): void {
        for (const child of nodes) {
            this.node(child, depth);
        }
    }

    /** `200  OK`: the summary (3.2) or the first description line next to the status code. */
    private response(node: DiffNode, depth: number): void {
        const [first, ...rest] = (node.attrs.summary ?? node.attrs.description ?? '').split('\n');
        this.row(node, depth, `${node.label}  ${first}`.trimEnd());
        const more = node.attrs.summary !== undefined ? node.attrs.description : rest.join('\n').trim() || undefined;
        this.text(more, node, depth + 1, 'description');
    }

    /**
     * A node that holds a schema: parameter, header, media type, property,
     * items, variant. An array prints as one row, `array[T]`, with the item
     * fields below it.
     */
    private schema(node: DiffNode, depth: number): void {
        const type = typeLabel(node);
        // A variant named after its schema would repeat the name: show the plain type instead.
        const shownType = node.kind === 'variant' && type === node.label ? (node.attrs.type ?? ['any']).join(' | ') : type;
        const facts = badges(node.attrs).map((fact) => (fact === 'required' ? fact : this.c.dim(fact)));
        const items = inlineItems(node);
        // The row also stands for its inline items, so it shows their change too.
        const shown = node.status === 'unchanged' && items?.status === 'changed' ? { ...node, status: items.status, verdict: items.verdict } : node;
        this.row(shown, depth, [node.label, this.c.cyan(shownType), ...facts].join('  '));

        const inner = depth + 1;
        this.text(node.attrs.description, node, inner, 'description');
        for (const detail of details(node.attrs)) {
            this.detail(node, inner, this.c.dim(detail));
        }
        this.changes(node.changes, inner);
        if (items !== undefined) {
            const itemFacts = [...badges(items.attrs), ...details(items.attrs)];
            if (itemFacts.length > 0) {
                this.detail(items, inner, this.c.dim(`Items: ${itemFacts.join(', ')}`));
            }
            this.changes(items.changes, inner, 'items ');
            this.children(items.children, inner);
        }
        this.children(node.children.filter((child) => child !== items), inner);
    }

    // --- Lines ---------------------------------------------------------------

    /** The main line of a node: its marker, its text, and the reason when it is the root of an added or removed subtree. */
    private row(node: DiffNode, depth: number, text: string): void {
        const tone = rowTone(node);
        this.line(MARKERS[node.status], depth, this.paint(tone, text + breakingTag(node.verdict)), tone);
    }

    /**
     * Free text of the attribute `attr`, one line per text line. When the text
     * changed, the change lines show it, so it does not print here too.
     */
    private text(text: string | undefined, node: DiffNode, depth: number, attr: AttrName, dim = true): void {
        if (changed(node, attr)) {
            return;
        }
        for (const line of text?.split('\n') ?? []) {
            this.detail(node, depth, dim ? this.c.dim(line.trimEnd()) : line.trimEnd());
        }
    }

    /**
     * A detail line of a node (description, allowed values). It carries the
     * marker only when the whole node is added or removed. On a changed node
     * the change lines show what changed.
     */
    private detail(node: DiffNode, depth: number, text: string): void {
        const whole = node.status === 'added' || node.status === 'removed';
        this.line(whole ? MARKERS[node.status] : ' ', depth, text, whole ? rowTone(node) : undefined);
    }

    /** One line per changed attribute, with the reason when breaking. `prefix` names the part, for example `items `. */
    private changes(changes: AttrChange[], depth: number, prefix = ''): void {
        for (const change of changes) {
            const tone: Tone = change.severity === 'breaking' ? 'breaking' : 'changed';
            if (isLongText(change.before) || isLongText(change.after)) {
                // Long text shows old and new in full, one line each.
                this.line('~', depth, this.paint(tone, `${prefix}${change.name} changed:${breakingTag(change)}`), tone);
                for (const [marker, value] of [['-', change.before], ['+', change.after]] as const) {
                    for (const line of typeof value === 'string' ? value.split('\n') : ['(none)']) {
                        this.line(marker, depth + 1, this.paint(tone, line), tone);
                    }
                }
                continue;
            }
            this.line('~', depth, this.paint(tone, describeChange(change, prefix) + breakingTag(change)), tone);
        }
    }

    private summary(report: DiffReport): void {
        const e = report.endpoints;
        const parts = [
            `${e.breaking} changed with breaking changes`,
            `${e.compatible} changed compatibly`,
            `${e.added} added`,
            `${e.removed} removed`,
            `${e.unchanged} unchanged`,
        ];
        this.lines.push(`Endpoints: ${parts.join(', ')}.`);
        // Changes to document facts (servers, version) are outside the endpoint counts.
        const documents = report.documents.filter((doc) => doc.info.impact !== undefined);
        if (documents.length > 0) {
            const breaking = documents.filter((doc) => doc.info.impact === 'breaking').length;
            this.lines.push(`Document information: ${documents.length} changed${breaking > 0 ? `, ${breaking} with breaking changes` : ''}.`);
        }
        if (!this.options.all && e.unchanged > 0) {
            this.lines.push(this.c.dim('Run with --all to show the unchanged endpoints.'));
        }
        this.lines.push(report.breaking ? this.c.red.bold('Result: breaking changes found.') : this.c.green.bold('Result: no breaking changes.'));
    }

    private line(marker: string, depth: number, text: string, tone?: Tone): void {
        this.lines.push(`${this.paint(tone, marker)} ${'  '.repeat(depth)}${text}`.trimEnd());
    }

    private paint(tone: Tone, text: string): string {
        switch (tone) {
            case 'added':
                return this.c.green(text);
            case 'breaking':
                return this.c.red(text);
            case 'changed':
                return this.orange(text);
            default:
                return text;
        }
    }
}

function toneOf(status: ChangeStatus, severity: Severity | undefined): Tone {
    if (status === 'unchanged') {
        return undefined;
    }
    if (severity === 'breaking') {
        return 'breaking';
    }
    return status === 'added' ? 'added' : 'changed';
}

/** The tone of a node's own line: from its own change, not from changes below it. */
function rowTone(node: DiffNode): Tone {
    return toneOf(node.status, node.verdict?.severity);
}

/** The attribute has a change line on this node. */
function changed(node: DiffNode, attr: AttrName): boolean {
    return node.changes.some((change) => change.name === attr);
}

/** `  [breaking: reason]` for a breaking verdict that has a reason, else nothing. */
function breakingTag(verdict: { severity: Severity; reason?: string } | undefined): string {
    return verdict?.severity === 'breaking' && verdict.reason !== undefined ? `  [breaking: ${verdict.reason}]` : '';
}

/** The label at the end of an endpoint header. */
function badge(op: DiffNode): string {
    const outcome = endpointOutcome(op);
    if (outcome === 'added' || outcome === 'removed') {
        return breakingTag(op.verdict).trim() || `[${outcome}]`;
    }
    return outcome === 'unchanged' ? '' : outcome === 'breaking' ? '[breaking]' : '[changed]';
}

function isLongText(value: unknown): boolean {
    return typeof value === 'string' && (value.includes('\n') || value.length > 60);
}
