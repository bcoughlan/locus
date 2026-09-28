/**
 * HTML text helpers: escaping, a small Markdown subset for descriptions, a
 * word diff for changed text, and schema lines as HTML.
 *
 * Input documents are untrusted. Every function here escapes the text first
 * and adds only its own markup. Links keep only safe URLs.
 */
import type { Line } from './layout.ts';
import { flatten } from './text.ts';
import type { Text, Tone } from './text.ts';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escape(text: string): string {
    return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** Styled text as HTML: each plain string escaped, each style a span. */
export function styled(text: Text): string {
    return flatten(text, escape, (style, inner) => `<span class="s-${style}">${inner}</span>`);
}

export function toneClass(tone: Tone | undefined): string {
    return tone === undefined ? 't-none' : `t-${tone}`;
}

/** Schema lines as rows of a marker column and indented text. */
export function linesHtml(lines: Line[]): string {
    const rows = lines.map(
        (line) =>
            `<div class="line ${toneClass(line.tone)}" style="--depth:${line.depth}"><span class="marker">${escape(line.marker)}</span><span class="text">${styled(line.text)}</span></div>`,
    );
    return `<div class="lines">${rows.join('')}</div>`;
}

// --- Markdown ----------------------------------------------------------------

/**
 * Markdown as HTML, for the subset that API descriptions use: paragraphs,
 * lists, headings, fenced code, inline code, bold, italic, and links. Raw
 * HTML in the text shows as text.
 */
export function markdown(text: string): string {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const blocks: string[] = [];
    let i = 0;
    const isListItem = (line: string) => /^\s*([-*+]|\d+[.)])\s+/.test(line);
    const isBlockStart = (line: string) => line.trim() === '' || /^\s*```/.test(line) || /^\s*#{1,6}\s/.test(line) || isListItem(line);
    while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '') {
            i++;
        } else if (/^\s*```/.test(line)) {
            const code: string[] = [];
            for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) {
                code.push(lines[i]);
            }
            i++;
            blocks.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
        } else if (/^\s*#{1,6}\s/.test(line)) {
            blocks.push(`<p class="md-heading">${inline(line.replace(/^\s*#+\s*/, '').replace(/\s*#+\s*$/, ''))}</p>`);
            i++;
        } else if (isListItem(line)) {
            const ordered = /^\s*\d/.test(line);
            const items: string[] = [];
            while (i < lines.length && (isListItem(lines[i]) || (items.length > 0 && /^\s+\S/.test(lines[i])))) {
                if (isListItem(lines[i])) {
                    items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
                } else {
                    items[items.length - 1] += ` ${lines[i].trim()}`;
                }
                i++;
            }
            const tag = ordered ? 'ol' : 'ul';
            blocks.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
        } else {
            const paragraph: string[] = [];
            while (i < lines.length && (paragraph.length === 0 || !isBlockStart(lines[i]))) {
                paragraph.push(lines[i].trim());
                i++;
            }
            blocks.push(`<p>${inline(paragraph.join(' '))}</p>`);
        }
    }
    return blocks.join('');
}

/** Inline Markdown: code spans stay as they are, the rest gets bold, italic, and links. */
function inline(text: string): string {
    return text
        .split(/(`[^`]+`)/)
        .map((part, i) => {
            if (i % 2 === 1) {
                return `<code>${escape(part.slice(1, -1))}</code>`;
            }
            return escape(part)
                .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) =>
                    safeUrl(url) ? `<a href="${url}" rel="noopener noreferrer">${label}</a>` : label,
                )
                .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?![\w*])/g, '$1<em>$2</em>');
        })
        .join('');
}

/** Web and mail links, and links within the page. No `javascript:` or other schemes. */
function safeUrl(url: string): boolean {
    return /^(https?:\/\/|mailto:|#)/i.test(url);
}

// --- Word diff ---------------------------------------------------------------

/** Above this many token pairs, the diff shows old and new text whole instead of word by word. */
const MAX_DIFF_CELLS = 250_000;

/**
 * Old and new text as one HTML text: removed words in `<del>`, added words in
 * `<ins>`. A missing side counts as empty.
 */
export function wordDiff(before: string | undefined, after: string | undefined): string {
    const a = tokens(before ?? '');
    const b = tokens(after ?? '');
    if (a.length * b.length > MAX_DIFF_CELLS) {
        return `${mark('del', before ?? '')} ${mark('ins', after ?? '')}`;
    }
    // Longest common subsequence, filled from the end.
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
        }
    }
    const out: string[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            out.push(escape(a[i]));
            i++;
            j++;
        } else if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
            // Removed words come before added words, as in a unified diff.
            out.push(mark('del', a[i++]));
        } else {
            out.push(mark('ins', b[j++]));
        }
    }
    // Neighboring marks of one kind merge, so a changed phrase reads as one.
    return out.join('').replace(/<\/(del|ins)><\1>/g, '');
}

function tokens(text: string): string[] {
    return text.split(/(\s+)/).filter((token) => token !== '');
}

function mark(tag: 'del' | 'ins', text: string): string {
    return text === '' ? '' : `<${tag}>${escape(text)}</${tag}>`;
}
