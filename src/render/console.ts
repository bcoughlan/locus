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
import type { ChalkInstance } from 'chalk';
import type { AttrChange, ChangeStatus, DiffNode, DiffReport, DocumentDiff, Severity } from '../diff/report.ts';
import { arrayItems, badges, changeValue, details, flowLabel, schemeLabel, typeLabel } from './format.ts';

/** Chalk color levels: 0 none, 1 basic 16 colors, 2 256 colors, 3 truecolor. */
export type ColorLevel = 0 | 1 | 2 | 3;

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
    private readonly options: ConsoleOptions;

    constructor(options: ConsoleOptions) {
        this.options = options;
        this.c = new Chalk({ level: options.color });
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
        const info = doc.info.attrs;
        const title = [info.title, info.version].filter(Boolean).join(' ');
        this.line(markerOf(doc.status), 0, `${this.paint(tone, this.c.bold(name + note))}  ${this.c.dim(title)}`, tone);
        this.changes(doc.info.changes, 1);
        for (const warning of doc.warnings) {
            this.line(' ', 1, this.c.magenta(`warning: ${warning}`));
        }
        this.lines.push('');

        const endpoints = (list: DiffNode[]) => list.filter((op) => this.options.all || op.status !== 'unchanged' || op.impact !== undefined);
        for (const op of endpoints(doc.operations)) {
            this.operation(op, 1);
        }
        const webhooks = endpoints(doc.webhooks);
        if (webhooks.length > 0) {
            this.line(' ', 1, this.c.bold('Webhooks'));
            this.lines.push('');
            for (const op of webhooks) {
                this.operation(op, 1);
            }
        }
    }

    private operation(op: DiffNode, depth: number): void {
        const status = op.status === 'unchanged' && op.impact !== undefined ? 'changed' : op.status;
        const tone = toneOf(status, op.status === 'added' || op.status === 'removed' ? op.verdict?.severity : op.impact);
        const a = op.attrs;
        const parts = [this.paint(tone, this.c.bold(`${a.method} ${a.path}`))];
        if (a.operationId !== undefined) {
            parts.push(this.c.dim(a.operationId));
        }
        if (a.deprecated) {
            parts.push(this.c.dim('deprecated'));
        }
        parts.push(this.paint(tone, badge(op)));
        this.line(markerOf(status), depth, parts.filter(Boolean).join('  '), tone);

        const inner = depth + 1;
        if (a.summary !== undefined) {
            this.detail(op, inner, a.summary);
        }
        this.text(a.description, op, inner);
        if (a.tags !== undefined) {
            this.detail(op, inner, this.c.dim(`Tags: ${a.tags.join(', ')}`));
        }
        if (a.servers !== undefined) {
            this.detail(op, inner, this.c.dim(`Servers: ${a.servers.join(', ')}`));
        }
        this.changes(op.changes, inner);
        for (const child of op.children) {
            this.node(child, inner);
        }
        this.lines.push('');
    }

    // --- Nodes ---------------------------------------------------------------

    private node(node: DiffNode, depth: number): void {
        switch (node.kind) {
            case 'operation':
                this.operation(node, depth);
                return;
            case 'section':
            case 'group':
            case 'callback':
                this.row(node, depth, node.kind === 'group' ? node.label : this.c.bold(node.label));
                this.children(node.children, depth + 1);
                return;
            case 'securityRequirement':
                this.securityRequirement(node, depth);
                return;
            case 'securityScheme':
                this.row(node, depth, `${this.label(node)}  ${schemeLabel(node.attrs)}`);
                this.text(node.attrs.description, node, depth + 1);
                this.changes(node.changes, depth + 1);
                this.children(node.children, depth + 1);
                return;
            case 'oauthFlow':
                this.row(node, depth, `${this.label(node)}  ${this.c.dim(flowLabel(node.attrs))}`);
                this.changes(node.changes, depth + 1);
                return;
            case 'response':
                this.response(node, depth);
                return;
            case 'requestBody':
                this.row(node, depth, [this.label(node, 'Body'), node.attrs.required ? 'required' : ''].filter(Boolean).join('  '));
                this.text(node.attrs.description, node, depth + 1);
                this.changes(node.changes, depth + 1);
                this.children(node.children, depth + 1);
                return;
            default:
                this.schema(node, depth);
        }
    }

    private children(nodes: DiffNode[], depth: number): void {
        for (const child of nodes) {
            this.node(child, depth);
        }
    }

    /** A requirement with a single scheme prints as that scheme's line. */
    private securityRequirement(node: DiffNode, depth: number): void {
        const [only] = node.children;
        if (node.children.length === 1 && only.key === node.key) {
            this.node({ ...only, verdict: node.verdict ?? only.verdict }, depth);
            return;
        }
        this.row(node, depth, this.label(node));
        this.children(node.children, depth + 1);
    }

    private response(node: DiffNode, depth: number): void {
        const [first, ...rest] = (node.attrs.summary ?? node.attrs.description ?? '').split('\n');
        this.row(node, depth, `${this.label(node)}  ${first}`.trimEnd());
        const more = node.attrs.summary !== undefined ? node.attrs.description : rest.join('\n').trim() || undefined;
        this.text(more, node, depth + 1);
        this.changes(node.changes, depth + 1);
        this.children(node.children, depth + 1);
    }

    /**
     * A node that holds a schema: parameter, header, media type, property,
     * items, variant. An array whose items match prints as one row, `array[T]`,
     * with the item fields below it.
     */
    private schema(node: DiffNode, depth: number): void {
        const items = arrayItems(node);
        const collapse = items !== undefined && (items.status === 'unchanged' || items.status === 'changed' || items.status === node.status);
        const facts = badges(node.attrs);
        const cells = [this.label(node), this.c.cyan(typeLabel(node)), ...facts.map((fact) => (fact === 'required' ? fact : this.c.dim(fact)))];
        this.row(node, depth, cells.join('  '));

        const inner = depth + 1;
        this.text(node.attrs.description, node, inner);
        for (const detail of details(node.attrs)) {
            this.detail(node, inner, this.c.dim(detail));
        }
        this.changes(node.changes, inner);
        if (collapse) {
            const itemFacts = [...badges(items.attrs), ...details(items.attrs)];
            if (itemFacts.length > 0) {
                this.detail(items, inner, this.c.dim(`Items: ${itemFacts.join(', ')}`));
            }
            this.changes(items.changes.map((change) => ({ ...change, label: `items ${change.name}` })), inner);
            this.children(items.children, inner);
        }
        this.children(collapse ? node.children.filter((child) => child !== items) : node.children, inner);
    }

    // --- Lines ---------------------------------------------------------------

    /** The main line of a node: its marker, its text, and the reason when it is the root of an added or removed subtree. */
    private row(node: DiffNode, depth: number, text: string): void {
        const tone = rowTone(node);
        const reason = node.verdict?.severity === 'breaking' && node.verdict.reason !== undefined ? `  [breaking: ${node.verdict.reason}]` : '';
        this.line(markerOf(node.status), depth, this.paint(tone, text) + this.paint(tone, reason), tone);
    }

    /** The display name of a node. An unnamed variant (`#2`) shows as `option 2`. */
    private label(node: DiffNode, fallback?: string): string {
        return fallback ?? (node.kind === 'variant' && node.key.startsWith('#') ? `option ${node.key.slice(1)}` : node.label);
    }

    /** Free text (a description), one line per text line. */
    private text(text: string | undefined, node: DiffNode, depth: number): void {
        if (text === undefined) {
            return;
        }
        for (const line of text.split('\n')) {
            this.detail(node, depth, this.c.dim(line.trimEnd()));
        }
    }

    /**
     * A detail line of a node (description, allowed values). It carries the
     * marker only when the whole node is added or removed. On a changed node
     * the change lines show what changed.
     */
    private detail(node: DiffNode, depth: number, text: string): void {
        const whole = node.status === 'added' || node.status === 'removed';
        this.line(whole ? markerOf(node.status) : ' ', depth, text, whole ? rowTone(node) : undefined);
    }

    /** One line per changed attribute: `name: before → after`, with the reason when breaking. */
    private changes(changes: (AttrChange & { label?: string })[], depth: number): void {
        for (const change of changes) {
            const tone: Tone = change.severity === 'breaking' ? 'breaking' : 'changed';
            const tag = change.severity === 'breaking' ? `  [breaking: ${change.reason}]` : '';
            const name = change.label ?? change.name;
            if (isLongText(change.before) || isLongText(change.after)) {
                // Long text shows old and new in full, one line each.
                this.line('~', depth, this.paint(tone, `${name} changed:${tag}`), tone);
                for (const [marker, value] of [['-', change.before], ['+', change.after]] as const) {
                    for (const line of typeof value === 'string' ? value.split('\n') : ['(none)']) {
                        this.line(marker, depth + 1, this.paint(tone, line), tone);
                    }
                }
                continue;
            }
            this.line('~', depth, this.paint(tone, `${name}: ${changeValue(change, 'before')} → ${changeValue(change, 'after')}${tag}`), tone);
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
                return this.c.hex('#FFA500')(text);
            default:
                return text;
        }
    }
}

function markerOf(status: ChangeStatus): string {
    return MARKERS[status];
}

function toneOf(status: ChangeStatus, severity: Severity | undefined): Tone {
    if (status === 'unchanged' || severity === undefined) {
        return status === 'unchanged' ? undefined : 'changed';
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

/** The label at the end of an endpoint header. */
function badge(op: DiffNode): string {
    if (op.status === 'added' || op.status === 'removed') {
        return op.verdict?.severity === 'breaking' ? `[breaking: ${op.verdict.reason ?? op.status}]` : `[${op.status}]`;
    }
    return op.impact === 'breaking' ? '[breaking]' : op.impact === 'compatible' ? '[changed]' : '';
}

function isLongText(value: unknown): boolean {
    return typeof value === 'string' && (value.includes('\n') || value.length > 60);
}
