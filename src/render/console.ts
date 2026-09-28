/**
 * Console renderer: prints the docs model (`docs.ts`) as indented text.
 *
 * Each line starts with a marker column, as in a unified diff: `+` added,
 * `-` removed, `~` changed. Colors repeat the markers: green for additions,
 * orange for compatible changes, red for breaking changes. Breaking changes
 * also carry a `[breaking: reason]` tag, so the output keeps all information
 * without color.
 */
import { Chalk } from 'chalk';
import type { ChalkInstance, ColorSupportLevel } from 'chalk';
import type { AttrChange, DiffReport } from '../diff/report.ts';
import { DIGEST_LIMIT, digestText, documentView } from './docs.ts';
import type { BodyView, CallbackView, DocumentView, EndpointView, PartView, ResponseView, RowView, SchemeView, SecurityView, State, TableView, TextView } from './docs.ts';
import { breakingTag, changed, changeLines, MARKERS } from './layout.ts';
import type { Line } from './layout.ts';
import { bold, dim, flatten, join, toned, type, warning } from './text.ts';
import type { Style, Text } from './text.ts';

/** Chalk color levels: 0 none, 1 basic 16 colors, 2 256 colors, 3 truecolor. */
export type ColorLevel = ColorSupportLevel;

export interface ConsoleOptions {
    color: ColorLevel;
    /** Print unchanged documents and endpoints too. */
    all: boolean;
}

export function renderConsole(report: DiffReport, options: ConsoleOptions): string {
    return new ConsoleRenderer(options).render(report);
}

class ConsoleRenderer {
    private readonly lines: string[] = [];
    private readonly c: ChalkInstance;
    private readonly styles: Record<Style, ChalkInstance>;
    private readonly options: ConsoleOptions;

    constructor(options: ConsoleOptions) {
        this.options = options;
        this.c = new Chalk({ level: options.color });
        this.styles = {
            added: this.c.green,
            breaking: this.c.red,
            changed: this.c.hex('#FFA500'),
            bold: this.c.bold,
            dim: this.c.dim,
            type: this.c.cyan,
            warning: this.c.magenta,
        };
    }

    render(report: DiffReport): string {
        this.lines.push(this.c.bold(`Comparing ${report.baseLabel} → ${report.headLabel}`), '');
        // An unchanged document still shows when it has warnings: part of it was not compared.
        const shown = report.documents.filter((doc) => this.options.all || doc.status !== 'unchanged' || doc.warnings.length > 0);
        for (const doc of shown) {
            this.document(documentView(doc, this.options.all));
        }
        this.summary(report);
        return `${this.lines.join('\n')}\n`;
    }

    // --- Documents and endpoints ---------------------------------------------

    private document(doc: DocumentView): void {
        this.line(MARKERS[doc.state.status], 0, [toned(doc.state.tone, bold(doc.name + doc.note)), '  ', dim(doc.title)], doc.state.tone);
        this.changes(doc.diff.info.changes, 1);
        for (const text of doc.warnings) {
            this.line(' ', 1, warning(`warning: ${text}`));
        }
        this.lines.push('');
        for (const op of doc.operations) {
            this.endpoint(op, 1);
            // A blank line ends each endpoint.
            this.lines.push('');
        }
        if (doc.webhooks.length > 0) {
            this.line(' ', 1, bold('Webhooks'));
            this.lines.push('');
            for (const op of doc.webhooks) {
                this.endpoint(op, 1);
                this.lines.push('');
            }
        }
    }

    private endpoint(op: EndpointView, depth: number): void {
        const tone = op.state.tone;
        const parts: Text[] = [toned(tone, bold(`${op.method} ${op.path}`))];
        if (op.operationId !== undefined) {
            parts.push(dim(op.operationId));
        }
        if (op.deprecated) {
            parts.push(dim('deprecated'));
        }
        if (op.badge !== '') {
            parts.push(toned(tone, op.badge));
        }
        this.line(MARKERS[op.state.status], depth, join(parts, '  '), tone);

        const inner = depth + 1;
        const whole = this.whole(op.state);
        this.text(op.summary, inner, whole, false);
        this.text(op.description, inner, whole);
        if (op.tags.length > 0 && !changed(op.changes, 'tags')) {
            this.line(whole.marker, inner, dim(`Tags: ${op.tags.join(', ')}`), whole.tone);
        }
        if (op.servers.length > 0 && !changed(op.changes, 'servers')) {
            this.line(whole.marker, inner, dim(`Servers: ${op.servers.join(', ')}`), whole.tone);
        }
        this.changes(op.changes, inner);
        if (op.digest.length > 0) {
            this.line(' ', inner, bold('Changes'));
            for (const entry of op.digest.slice(0, DIGEST_LIMIT)) {
                this.line(MARKERS[entry.status], inner + 1, toned(entry.tone, digestText(entry)), entry.tone);
            }
            if (op.digest.length > DIGEST_LIMIT) {
                this.line(' ', inner + 1, dim(`… ${op.digest.length - DIGEST_LIMIT} more`));
            }
        }
        for (const section of op.sections) {
            this.row(section.state, inner, bold(section.title));
            for (const part of section.parts) {
                this.part(part, inner + 1);
            }
        }
    }

    // --- Parts ---------------------------------------------------------------

    private part(part: PartView, depth: number): void {
        switch (part.kind) {
            case 'table':
                this.table(part, depth);
                break;
            case 'security':
                this.security(part, depth);
                break;
            case 'body':
                this.body(part, depth);
                break;
            case 'response':
                this.response(part, depth);
                break;
            case 'callback':
                this.callback(part, depth);
                break;
        }
    }

    private table(table: TableView, depth: number): void {
        if (table.title === '') {
            table.rows.forEach((row) => this.schemaRow(row, depth));
            return;
        }
        this.row(table.state, depth, table.title);
        table.rows.forEach((row) => this.schemaRow(row, depth + 1));
    }

    /** A parameter, header, or media type: `name  type  badges`, its text, its changes, and its schema. */
    private schemaRow(row: RowView, depth: number): void {
        const facts = row.facts.map((fact) => (fact === 'required' ? fact : dim(fact)));
        const typeText = row.stop === undefined ? row.type : `${row.type} (${row.stop})`;
        this.row(row.state, depth, join([row.name, type(typeText), ...facts], '  '));
        const inner = depth + 1;
        const whole = this.whole(row.state);
        this.text(row.description, inner, whole);
        for (const detail of row.details) {
            this.line(whole.marker, inner, dim(detail), whole.tone);
        }
        this.changes(row.changes, inner);
        this.schemaLines(row.schema, inner);
    }

    private security(security: SecurityView, depth: number): void {
        for (const requirement of security.requirements) {
            const [first] = requirement.schemes;
            if (requirement.schemes.length === 1 && first.name === requirement.label) {
                this.scheme({ ...first, state: requirement.state }, depth);
                continue;
            }
            this.row(requirement.state, depth, requirement.label);
            requirement.schemes.forEach((scheme) => this.scheme(scheme, depth + 1));
        }
    }

    private scheme(scheme: SchemeView, depth: number): void {
        this.row(scheme.state, depth, `${scheme.name}  ${scheme.label}`);
        this.text(scheme.description, depth + 1, this.whole(scheme.state));
        this.changes(scheme.changes, depth + 1);
        for (const flow of scheme.flows) {
            this.row(flow.state, depth + 1, [`${flow.name}  `, dim(flow.label)]);
            this.changes(flow.changes, depth + 2);
        }
    }

    private body(body: BodyView, depth: number): void {
        this.row(body.state, depth, body.required ? 'Body  required' : 'Body');
        this.text(body.description, depth + 1, this.whole(body.state));
        this.changes(body.changes, depth + 1);
        body.media.forEach((row) => this.schemaRow(row, depth + 1));
    }

    /** `200  OK`: the summary (3.2) or the first description line next to the status code. */
    private response(response: ResponseView, depth: number): void {
        const summary = response.summary.text;
        const [first, ...rest] = (summary ?? response.description.text ?? '').split('\n');
        this.row(response.state, depth, `${response.code}  ${first}`.trimEnd());
        const inner = depth + 1;
        const whole = this.whole(response.state);
        const more = summary !== undefined ? response.description : { text: rest.join('\n').trim() || undefined, change: response.description.change };
        this.text(more, inner, whole);
        if (response.summary.change !== undefined) {
            this.changes([response.summary.change], inner);
        }
        this.changes(response.changes, inner);
        if (response.headers !== undefined) {
            this.table(response.headers, inner);
        }
        response.media.forEach((row) => this.schemaRow(row, inner));
    }

    private callback(callback: CallbackView, depth: number): void {
        this.row(callback.state, depth, bold(callback.name));
        callback.endpoints.forEach((op) => this.endpoint(op, depth + 1));
    }

    // --- Lines ---------------------------------------------------------------

    /** The main line of a part: its marker, its text, and the reason when it is the root of an added or removed subtree. */
    private row(state: State, depth: number, text: Text): void {
        const reason = state.status === 'added' || state.status === 'removed' ? state.reason : undefined;
        const tag = breakingTag(reason === undefined ? undefined : { severity: state.severity ?? 'compatible', reason });
        this.line(MARKERS[state.status], depth, toned(state.tone, [text, tag]), state.tone);
    }

    /** Detail lines carry the marker only when the whole part is added or removed. */
    private whole(state: State): { marker: string; tone?: State['tone'] } {
        return state.status === 'added' || state.status === 'removed' ? { marker: MARKERS[state.status], tone: state.tone } : { marker: ' ' };
    }

    /** Free text, one line per text line. When it changed, the change lines show it instead. */
    private text(text: TextView, depth: number, whole: { marker: string; tone?: State['tone'] }, dimmed = true): void {
        if (text.change !== undefined) {
            this.changes([text.change], depth);
            return;
        }
        for (const line of text.text?.split('\n') ?? []) {
            this.line(whole.marker, depth, dimmed ? dim(line.trimEnd()) : line.trimEnd(), whole.tone);
        }
    }

    private changes(changes: AttrChange[], depth: number): void {
        for (const change of changes) {
            this.schemaLines(changeLines(change, 0), depth);
        }
    }

    private schemaLines(lines: Line[], depth: number): void {
        for (const line of lines) {
            this.line(line.marker, depth + line.depth, line.text, line.tone);
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

    private line(marker: string, depth: number, text: Text, tone?: State['tone']): void {
        const painted = tone === undefined ? marker : this.styles[tone](marker);
        const content = flatten(text, (plain) => plain, (style, inner) => this.styles[style](inner));
        this.lines.push(`${painted} ${'  '.repeat(depth)}${content}`.trimEnd());
    }
}
