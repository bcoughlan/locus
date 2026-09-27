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
import { badges, changeDistances, describeChange, details, flowLabel, inlineItems, schemeLabel, show, typeLabel } from './format.ts';
import type { Definitions } from './format.ts';

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

/**
 * After this many lines in one endpoint, the endpoint shows only the paths to
 * its changes. A referenced schema expands only when it is on a shortest path
 * to a change, and only once. Unchanged nodes show as a count.
 */
const LARGE_ENDPOINT = 400;

class ConsoleRenderer {
    private readonly lines: string[] = [];
    private readonly c: ChalkInstance;
    private readonly orange: ChalkInstance;
    private readonly options: ConsoleOptions;
    /** The definition diffs of the document being printed. */
    private definitions: Definitions = () => undefined;
    /** The references to the nearest change, per definition of the document being printed. */
    private distances = new Map<string, number>();
    /** Definitions whose content is being printed, innermost last: a reference to one of them is a cycle. */
    private readonly open: string[] = [];
    /** Definitions printed in full in the current endpoint, and the line where that endpoint starts. */
    private readonly printed = new Set<string>();
    private endpointStart = 0;

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
        this.definitions = (id) => doc.schemas[id];
        this.distances = changeDistances(doc.schemas);
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
        if (depth === 1) {
            this.endpointStart = this.lines.length;
            this.printed.clear();
        }
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

    /** Print the nodes. In a large endpoint, only the ones that lead to a change, and a count of the others. */
    private children(nodes: DiffNode[], depth: number): void {
        let skipped = 0;
        for (const child of nodes) {
            // Depth 1 holds the endpoints themselves.
            if (depth > 1 && this.isLarge() && !this.leadsToChange(child)) {
                skipped++;
                continue;
            }
            this.node(child, depth);
        }
        if (skipped > 0) {
            this.line(' ', depth, this.c.dim(`… ${skipped} unchanged, not shown`));
        }
    }

    /** The node changed, or a change shows below it: in its definition, or on a shortest path to a change. */
    private leadsToChange(node: DiffNode): boolean {
        if (node.status !== 'unchanged' || node.impact === undefined) {
            return node.status !== 'unchanged';
        }
        if (node.ref !== undefined) {
            // A path step prints even when its definition printed above, so the path stays complete.
            const cycle = this.open.includes(node.ref);
            return show(node, this.definitions).status !== 'unchanged' || (!cycle && this.onPath(node.ref, this.open));
        }
        return node.children.some((child) => this.leadsToChange(child));
    }

    private isLarge(): boolean {
        return this.lines.length - this.endpointStart > LARGE_ENDPOINT;
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
     * items, variant. A reference prints its definition in place. An array
     * prints as one row, `array[T]`, with the item fields below it.
     */
    private schema(node: DiffNode, depth: number): void {
        const shown = show(node, this.definitions);
        const stop = this.stopAt(node);
        const items = stop === undefined ? inlineItems(shown) : undefined;
        const itemsShown = items === undefined ? undefined : show(items, this.definitions);
        const itemsStop = items === undefined ? undefined : this.stopAt(items, node.ref);

        const type = typeLabel(node, this.definitions);
        // A variant named after its schema would repeat the name: show the plain type instead.
        const plain = node.kind === 'variant' && type === node.label ? (shown.attrs.type ?? ['any']).join(' | ') : type;
        const note = stop ?? itemsStop;
        const facts = badges(shown.attrs).map((fact) => (fact === 'required' ? fact : this.c.dim(fact)));
        // The row also stands for its inline items, so it shows their change too.
        const itemsChanged = shown.status === 'unchanged' && itemsShown?.status === 'changed';
        this.row(node, depth, [node.label, this.c.cyan(note === undefined ? plain : `${plain} (${note})`), ...facts].join('  '), {
            status: itemsChanged ? 'changed' : shown.status,
            severity: itemsChanged ? itemsShown?.severity : shown.severity,
        });

        const inner = depth + 1;
        this.text(shown.attrs.description, node, inner, 'description', true, shown.changes);
        for (const detail of details(shown.attrs)) {
            this.detail(node, inner, this.c.dim(detail));
        }
        this.changes(shown.changes, inner);
        if (stop !== undefined) {
            return;
        }
        this.inside(node.ref, () => {
            if (items !== undefined && itemsShown !== undefined) {
                const itemFacts = [...badges(itemsShown.attrs), ...details(itemsShown.attrs)];
                if (itemFacts.length > 0) {
                    this.detail(items, inner, this.c.dim(`Items: ${itemFacts.join(', ')}`));
                }
                this.changes(itemsShown.changes, inner, 'items ');
                if (itemsStop === undefined) {
                    this.inside(items.ref, () => this.children(itemsShown.children, inner));
                }
            }
            this.children(shown.children.filter((child) => child !== items), inner);
        });
    }

    /**
     * Why a reference does not expand here: its definition is already open
     * above it (a cycle). Or the endpoint is large, and the definition
     * printed in full earlier, or is not on a shortest path to a change. In a
     * spec where every schema links to others, full expansion reaches most of
     * the spec, and so do all paths to a change. A large endpoint shows the
     * shortest paths to its changes and names the rest.
     *
     * `within` is a definition that the node prints inside but that is not
     * open yet: the node's parent, for inline array items.
     */
    private stopAt(node: DiffNode, within?: string): 'recursive' | 'shown above' | 'not expanded' | undefined {
        if (node.ref === undefined) {
            return undefined;
        }
        const open = within === undefined ? this.open : [...this.open, within];
        if (open.includes(node.ref)) {
            return 'recursive';
        }
        if (!this.isLarge()) {
            return undefined;
        }
        if (this.printed.has(node.ref)) {
            return 'shown above';
        }
        return this.onPath(node.ref, open) ? undefined : 'not expanded';
    }

    /**
     * The definition `ref` is on a shortest path to a change: it is closer to a
     * change than the innermost open definition. A changed definition always
     * counts, so it shows its change.
     */
    private onPath(ref: string, open: string[]): boolean {
        const status = this.definitions(ref)?.status;
        const distance = this.distances.get(ref);
        const enclosing = open.length === 0 ? undefined : this.distances.get(open[open.length - 1]);
        const closer = distance !== undefined && (distance === 0 || enclosing === undefined || distance < enclosing);
        return closer && status !== 'added' && status !== 'removed';
    }

    /** Print inside the definition `ref`: a reference to it below here is a cycle. */
    private inside(ref: string | undefined, print: () => void): void {
        if (ref === undefined) {
            print();
            return;
        }
        this.open.push(ref);
        this.printed.add(ref);
        try {
            print();
        } finally {
            this.open.pop();
        }
    }

    // --- Lines ---------------------------------------------------------------

    /**
     * The main line of a node: its marker, its text, and the reason when it is
     * the root of an added or removed subtree. `shown` overrides the status
     * and severity, for a row that also stands for a definition or inline items.
     */
    private row(node: DiffNode, depth: number, text: string, shown?: { status: ChangeStatus; severity?: Severity }): void {
        const status = shown?.status ?? node.status;
        const tone = toneOf(status, shown === undefined ? node.verdict?.severity : shown.severity);
        this.line(MARKERS[status], depth, this.paint(tone, text + breakingTag(node.verdict)), tone);
    }

    /**
     * Free text of the attribute `attr`, one line per text line. When the text
     * changed, the change lines show it, so it does not print here too.
     */
    private text(text: string | undefined, node: DiffNode, depth: number, attr: AttrName, dim = true, changes = node.changes): void {
        if (changes.some((change) => change.name === attr)) {
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
        // Changes to the facts of a document on both sides (servers, version) are outside the endpoint counts.
        const documents = report.documents.filter((doc) => doc.base !== undefined && doc.head !== undefined && doc.info.impact !== undefined);
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
