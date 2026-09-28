import { describe, expect, test } from 'vitest';
import { escape, markdown, wordDiff } from './html-text.ts';

describe('markdown', () => {
    test('paragraphs, lists, code, bold, and italic', () => {
        expect(markdown('First line\nsame paragraph.\n\n- one\n- **two**\n\nUse `a<b` and *this*.')).toBe(
            '<p>First line same paragraph.</p><ul><li>one</li><li><strong>two</strong></li></ul><p>Use <code>a&lt;b</code> and <em>this</em>.</p>',
        );
    });

    test('fenced code keeps its lines and escapes them', () => {
        expect(markdown('```\n<tag>\n  x\n```')).toBe('<pre><code>&lt;tag&gt;\n  x</code></pre>');
    });

    test('raw HTML shows as text', () => {
        expect(markdown('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    });

    test('links keep only web, mail, and page URLs', () => {
        expect(markdown('[guide](https://example.com/a?b=1&c=2)')).toBe('<p><a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">guide</a></p>');
        expect(markdown('[x](javascript:alert)')).toBe('<p>x</p>');
        expect(markdown('[x](https://a"onmouseover="alert)')).not.toContain('"onmouseover');
    });

    test('snake_case and a lone star stay as they are', () => {
        expect(markdown('page_size * 2')).toBe('<p>page_size * 2</p>');
    });
});

describe('wordDiff', () => {
    test('marks removed and added words', () => {
        expect(wordDiff('newest pets first', 'oldest pets first')).toBe('<del>newest</del><ins>oldest</ins> pets first');
    });

    test('a missing side counts as empty', () => {
        expect(wordDiff(undefined, 'new text')).toBe('<ins>new text</ins>');
        expect(wordDiff('old', undefined)).toBe('<del>old</del>');
    });

    test('escapes both sides', () => {
        expect(wordDiff('<a>', '<b>')).toBe('<del>&lt;a&gt;</del><ins>&lt;b&gt;</ins>');
    });
});

test('escape', () => {
    expect(escape(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});
