/**
 * Schema layout: turns the schema below a parameter, header, or media type
 * into lines of styled text, like an indented YAML file. The docs model
 * (`docs.ts`) holds these lines, and both renderers paint them.
 *
 * Each line has a marker, as in a unified diff: `+` added, `-` removed, `~`
 * changed, blank for unchanged. Its tone repeats the marker: added, a
 * compatible change, or a breaking change. Breaking changes also carry a
 * `[breaking: reason]` tag, so the lines keep all information without color.
 */
import { endpointOutcome } from '../diff/report.ts';
import type { AttrChange, ChangeStatus, DiffNode, Severity } from '../diff/report.ts';
import type { AttrName } from '../model/tree.ts';
import { badges, changeDistances, describeChange, details, inlineItems, show, typeLabel } from './format.ts';
import type { Definitions } from './format.ts';
import { dim, join, toned, type } from './text.ts';
import type { Text, Tone } from './text.ts';

export interface Line {
    marker: string;
    /** Indentation level, from 0. */
    depth: number;
    text: Text;
    /** The color of the marker. */
    tone?: Tone;
}

export const MARKERS: Record<ChangeStatus, string> = { added: '+', removed: '-', changed: '~', unchanged: ' ' };

/** Why a reference does not expand at a place. */
export type StopReason = 'recursive' | 'shown above' | 'not expanded';

/**
 * After this many schema lines in one endpoint, the endpoint shows only the
 * paths to its changes. A referenced schema expands only when it is on a
 * shortest path to a change, and only once. Unchanged nodes show as a count.
 */
const LARGE_ENDPOINT = 400;

export class SchemaLayout {
    private lines: Line[] = [];
    /** Schema lines laid out in the current endpoint before the current call. */
    private used = 0;
    private readonly definitions: Definitions;
    /** The references to the nearest change, per definition. */
    private readonly distances: Map<string, number>;
    /** Definitions whose content is being laid out, innermost last: a reference to one of them is a cycle. */
    private readonly open: string[] = [];
    /** Definitions shown in full in the current endpoint. */
    private readonly printed = new Set<string>();

    constructor(schemas: Record<string, DiffNode>) {
        this.definitions = (id) => schemas[id];
        this.distances = changeDistances(schemas);
    }

    /** Start a new endpoint: the line budget and the definitions shown so far start again. */
    startEndpoint(): void {
        this.used = 0;
        this.printed.clear();
    }

    /**
     * What a schema node holds below its own row: its inline array items and
     * its children. `stop` says why a reference does not expand here.
     */
    schemaBody(node: DiffNode): { stop?: StopReason; lines: Line[] } {
        this.lines = [];
        const stop = this.stopAt(node);
        if (stop === undefined) {
            this.inner(node, show(node, this.definitions), 0);
        }
        const lines = this.lines;
        // The node's own row counts too.
        this.used += lines.length + 1;
        return { stop, lines };
    }

    // --- Nodes ---------------------------------------------------------------

    /** Lay out the nodes. In a large endpoint, only the ones that lead to a change, and a count of the others. */
    private children(nodes: DiffNode[], depth: number): void {
        let skipped = 0;
        for (const child of nodes) {
            if (this.isLarge() && !this.leadsToChange(child)) {
                skipped++;
                continue;
            }
            this.schema(child, depth);
        }
        if (skipped > 0) {
            this.line(' ', depth, dim(`… ${skipped} unchanged, not shown`));
        }
    }

    /** The node changed, or a change shows below it: in its definition, or on a shortest path to a change. */
    private leadsToChange(node: DiffNode): boolean {
        if (node.status !== 'unchanged' || node.impact === undefined) {
            return node.status !== 'unchanged';
        }
        if (node.ref !== undefined) {
            // A path step shows even when its definition showed above, so the path stays complete.
            const cycle = this.open.includes(node.ref);
            return show(node, this.definitions).status !== 'unchanged' || (!cycle && this.onPath(node.ref, this.open));
        }
        return node.children.some((child) => this.leadsToChange(child));
    }

    private isLarge(): boolean {
        return this.used + this.lines.length > LARGE_ENDPOINT;
    }

    /**
     * A schema node: property, items, variant. A reference shows its
     * definition in place. An array shows as one row, `array[T]`, with the
     * item fields below it.
     */
    private schema(node: DiffNode, depth: number): void {
        const shown = show(node, this.definitions);
        const stop = this.stopAt(node);
        const items = stop === undefined ? inlineItems(shown) : undefined;
        const itemsStop = items === undefined ? undefined : this.stopAt(items, node.ref);

        const label = typeLabel(node, this.definitions);
        // A variant named after its schema would repeat the name: show the plain type instead.
        const plain = node.kind === 'variant' && label === node.label ? (shown.attrs.type ?? ['any']).join(' | ') : label;
        const note = stop ?? itemsStop;
        const facts = badges(shown.attrs).map((fact) => (fact === 'required' ? fact : dim(fact)));
        const state = rowState(node, this.definitions);
        const tone = toneOf(state.status, state.severity);
        this.line(MARKERS[state.status], depth, toned(tone, [join([node.label, type(note === undefined ? plain : `${plain} (${note})`), ...facts], '  '), breakingTag(node.verdict)]), tone);

        const inner = depth + 1;
        this.text(shown.attrs.description, node, inner, shown.changes);
        for (const detail of details(shown.attrs)) {
            this.detail(node, inner, dim(detail));
        }
        this.changes(shown.changes, inner);
        if (stop === undefined) {
            this.inner(node, shown, inner);
        }
    }

    /** The inline array items and the children of a schema node. */
    private inner(node: DiffNode, shown: ReturnType<typeof show>, depth: number): void {
        const items = inlineItems(shown);
        this.inside(node.ref, () => {
            if (items !== undefined) {
                const itemsShown = show(items, this.definitions);
                const itemFacts = [...badges(itemsShown.attrs), ...details(itemsShown.attrs)];
                if (itemFacts.length > 0) {
                    this.detail(items, depth, dim(`Items: ${itemFacts.join(', ')}`));
                }
                this.changes(itemsShown.changes, depth, 'items ');
                if (this.stopAt(items) === undefined) {
                    this.inside(items.ref, () => this.children(itemsShown.children, depth));
                }
            }
            this.children(shown.children.filter((child) => child !== items), depth);
        });
    }

    /**
     * Why a reference does not expand here: its definition is already open
     * above it (a cycle). Or the endpoint is large, and the definition
     * showed in full earlier, or is not on a shortest path to a change. In a
     * spec where every schema links to others, full expansion reaches most of
     * the spec, and so do all paths to a change. A large endpoint shows the
     * shortest paths to its changes and names the rest.
     *
     * `within` is a definition that the node shows inside but that is not
     * open yet: the node's parent, for inline array items.
     */
    private stopAt(node: DiffNode, within?: string): StopReason | undefined {
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

    /** Lay out inside the definition `ref`: a reference to it below here is a cycle. */
    private inside(ref: string | undefined, layout: () => void): void {
        if (ref === undefined) {
            layout();
            return;
        }
        this.open.push(ref);
        this.printed.add(ref);
        try {
            layout();
        } finally {
            this.open.pop();
        }
    }

    // --- Lines ---------------------------------------------------------------

    /** The description, one line per text line. When it changed, the change lines show it instead. */
    private text(text: string | undefined, node: DiffNode, depth: number, changes: AttrChange[]): void {
        if (changes.some((change) => change.name === 'description')) {
            return;
        }
        for (const line of text?.split('\n') ?? []) {
            this.detail(node, depth, dim(line.trimEnd()));
        }
    }

    /** A detail line of a node. It carries the marker only when the whole node is added or removed. */
    private detail(node: DiffNode, depth: number, text: Text): void {
        const whole = node.status === 'added' || node.status === 'removed';
        this.line(whole ? MARKERS[node.status] : ' ', depth, text, whole ? toneOf(node.status, node.verdict?.severity) : undefined);
    }

    /** One line per changed attribute. `prefix` names the part, for example `items `. */
    private changes(changes: AttrChange[], depth: number, prefix = ''): void {
        for (const change of changes) {
            this.lines.push(...changeLines(change, depth, prefix));
        }
    }

    private line(marker: string, depth: number, text: Text, tone?: Tone): void {
        this.lines.push({ marker, depth, text, tone });
    }
}

/**
 * The lines of one changed attribute, with the reason when breaking. Long
 * text shows old and new in full, one line each.
 */
export function changeLines(change: AttrChange, depth: number, prefix = ''): Line[] {
    const tone: Tone = change.severity === 'breaking' ? 'breaking' : 'changed';
    if (!isLongText(change.before) && !isLongText(change.after)) {
        return [{ marker: '~', depth, text: toned(tone, describeChange(change, prefix) + breakingTag(change)), tone }];
    }
    const lines: Line[] = [{ marker: '~', depth, text: toned(tone, `${prefix}${change.name} changed:${breakingTag(change)}`), tone }];
    for (const [marker, value] of [['-', change.before], ['+', change.after]] as const) {
        for (const line of typeof value === 'string' ? value.split('\n') : ['(none)']) {
            lines.push({ marker, depth: depth + 1, text: toned(tone, line), tone });
        }
    }
    return lines;
}

/** How a schema-holding node shows: its own status, or the change of its definition or of its inline items. */
export function rowState(node: DiffNode, definitions: Definitions): { status: ChangeStatus; severity?: Severity } {
    const shown = show(node, definitions);
    const items = inlineItems(shown);
    const itemsShown = items === undefined ? undefined : show(items, definitions);
    // The row also stands for its inline items, so it shows their change too.
    if (shown.status === 'unchanged' && itemsShown?.status === 'changed') {
        return { status: 'changed', severity: itemsShown.severity };
    }
    return { status: shown.status, severity: shown.severity };
}

/** The tone of a line: none when unchanged, else breaking, added, or changed. */
export function toneOf(status: ChangeStatus, severity: Severity | undefined): Tone | undefined {
    if (status === 'unchanged') {
        return undefined;
    }
    if (severity === 'breaking') {
        return 'breaking';
    }
    return status === 'added' ? 'added' : 'changed';
}

/** The status of an endpoint as a whole: `changed` when anything inside it changed. */
export function endpointStatus(op: DiffNode): ChangeStatus {
    const outcome = endpointOutcome(op);
    return outcome === 'added' || outcome === 'removed' ? outcome : outcome === 'unchanged' ? 'unchanged' : 'changed';
}

/** The tone of an endpoint header: its own verdict when added or removed, else the worst change inside. */
export function endpointTone(op: DiffNode): Tone | undefined {
    const status = endpointStatus(op);
    return toneOf(status, status === 'changed' ? op.impact : op.verdict?.severity);
}

/** `  [breaking: reason]` for a breaking verdict that has a reason, else nothing. */
export function breakingTag(verdict: { severity: Severity; reason?: string } | undefined): string {
    return verdict?.severity === 'breaking' && verdict.reason !== undefined ? `  [breaking: ${verdict.reason}]` : '';
}

/** The label at the end of an endpoint header, for example `[breaking]`. Empty for an unchanged endpoint. */
export function endpointBadge(op: DiffNode): string {
    const outcome = endpointOutcome(op);
    if (outcome === 'added' || outcome === 'removed') {
        return breakingTag(op.verdict).trim() || `[${outcome}]`;
    }
    return outcome === 'unchanged' ? '' : outcome === 'breaking' ? '[breaking]' : '[changed]';
}

/** Text that shows as old and new in full, instead of `old → new`. */
export function isLongText(value: unknown): boolean {
    return typeof value === 'string' && (value.includes('\n') || value.length > 60);
}

/** The attribute has a change on this node. */
export function changed(changes: AttrChange[], attr: AttrName): boolean {
    return changes.some((change) => change.name === attr);
}
