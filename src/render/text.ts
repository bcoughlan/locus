/**
 * Styled text: plain strings with style marks, and no escape codes or markup.
 * The layout builds lines from it. The console renderer turns it into ANSI
 * colors, the HTML renderer into escaped spans. A plain string is always
 * raw text, so the HTML renderer escapes every string it meets.
 */

/** What a line or a part of it means: added, breaking, or a compatible change. */
export type Tone = 'added' | 'breaking' | 'changed';

export type Style = Tone | 'bold' | 'dim' | 'type' | 'warning';

export type Text = string | Styled | readonly Text[];

export interface Styled {
    style: Style;
    text: Text;
}

export const bold = (text: Text): Styled => ({ style: 'bold', text });
export const dim = (text: Text): Styled => ({ style: 'dim', text });
/** A type label, such as `string<email>`. */
export const type = (text: Text): Styled => ({ style: 'type', text });
export const warning = (text: Text): Styled => ({ style: 'warning', text });

/** `text` in the color of `tone`. No tone: the text as it is. */
export function toned(tone: Tone | undefined, text: Text): Text {
    return tone === undefined ? text : { style: tone, text };
}

/** The parts with `separator` between them. */
export function join(parts: readonly Text[], separator: string): Text {
    return parts.flatMap((part, i) => (i === 0 ? [part] : [separator, part]));
}

/**
 * Turn styled text into a string: `plain` maps each raw string, `styled`
 * wraps the output of a styled part.
 */
export function flatten(text: Text, plain: (text: string) => string, styled: (style: Style, inner: string) => string): string {
    if (typeof text === 'string') {
        return plain(text);
    }
    if (Array.isArray(text)) {
        return text.map((part: Text) => flatten(part, plain, styled)).join('');
    }
    const { style, text: inner } = text as Styled;
    return styled(style, flatten(inner, plain, styled));
}
