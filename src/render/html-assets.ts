/** The style and script of the HTML page (`html.ts`). The page loads nothing else. */

export const CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --panel: #f6f8fa; --card: #ffffff; --border: #d8dee4; --text: #1f2328; --muted: #59636e;
  --added: #1a7f37; --added-bg: #dafbe1; --breaking: #cf222e; --breaking-bg: #ffebe9;
  --changed: #9a6700; --changed-bg: #fff8c5; --type: #0550ae; --accent: #0969da; --warning: #8250df; --current: #ddf4ff;
  --code-bg: #eff2f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --panel: #151b23; --card: #0d1117; --border: #3d444d; --text: #e6edf3; --muted: #9198a1;
    --added: #3fb950; --added-bg: #12261e; --breaking: #f85149; --breaking-bg: #2d1316;
    --changed: #d29922; --changed-bg: #272115; --type: #79c0ff; --accent: #4493f8; --warning: #d2a8ff; --current: #152b45;
    --code-bg: #212830;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
code, .lines, .path, .method, .type, .fact, .code { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
code { font-size: 0.88em; background: var(--code-bg); padding: 1px 5px; border-radius: 4px; }
a { color: var(--accent); }
.dim { color: var(--muted); }

/* Page header */
.top { position: sticky; top: 0; z-index: 3; background: var(--bg); border-bottom: 1px solid var(--border); padding: 12px 20px; }
.heading { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; }
.top h1 { font-size: 16px; margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.result { font-weight: 600; }
.result.breaking { color: var(--breaking); }
.result.ok { color: var(--added); }
.bar { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; margin-top: 10px; }
.pills { display: flex; flex-wrap: wrap; gap: 6px; }
.pill { border-radius: 999px; padding: 2px 10px; font-size: 13px; border: 1px solid currentColor; }
.pill.zero { opacity: 0.45; }
.p-breaking { color: var(--breaking); background: var(--breaking-bg); }
.p-added { color: var(--added); background: var(--added-bg); }
.p-removed { color: var(--breaking); background: var(--panel); }
.p-changed { color: var(--changed); background: var(--changed-bg); }
.toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.toggle button { font: inherit; font-size: 13px; padding: 3px 12px; border: 0; background: var(--panel); color: var(--muted); cursor: pointer; }
.toggle button + button { border-left: 1px solid var(--border); }
.toggle button[aria-pressed="true"] { background: var(--accent); color: #fff; }

/* Sidebar */
.page { display: grid; grid-template-columns: minmax(230px, 310px) minmax(0, 1fr); }
.sidebar { position: sticky; top: var(--top, 90px); align-self: start; max-height: calc(100vh - var(--top, 90px)); overflow-y: auto; border-right: 1px solid var(--border); padding: 12px 8px 24px; background: var(--panel); }
.search { width: 100%; font: inherit; font-size: 13px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); margin-bottom: 6px; }
.sidebar ul { list-style: none; margin: 0 0 6px; padding: 0; }
.sidebar a { display: flex; align-items: baseline; gap: 6px; padding: 2px 6px; border-radius: 4px; color: inherit; text-decoration: none; }
.sidebar a:hover { background: var(--border); }
.sidebar a.current { background: var(--current); }
.sidebar .marker { width: 1ch; flex: none; font-family: ui-monospace, monospace; }
.sidebar .path { font-size: 12.5px; overflow-wrap: anywhere; }
.sidebar li.removed .path { text-decoration: line-through; }
.sidebar li.unchanged a { color: var(--muted); }
.sidebar li.t-added .marker { color: var(--added); }
.sidebar li.t-breaking .marker { color: var(--breaking); }
.sidebar li.t-changed .marker { color: var(--changed); }
.nav-file { display: block; font-weight: 600; font-size: 13px; margin: 10px 0 2px; font-family: ui-monospace, monospace; }
.nav-heading { color: var(--muted); font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 6px 6px 2px; }
.no-match { display: none !important; }

/* Documents */
main { padding: 20px 28px 40vh; min-width: 0; max-width: 1180px; }
.doc { margin-bottom: 48px; }
.doc-head { border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 16px; }
.doc-head h2 { font-size: 26px; margin: 0; }
.doc-head.t-breaking h2 { color: var(--breaking); }
.version { font-size: 14px; font-weight: 500; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; vertical-align: middle; }
.doc-file { margin: 4px 0 8px; color: var(--muted); }
.warning { color: var(--warning); }
.tag-heading { font-size: 20px; margin: 32px 0 12px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }

/* Endpoints */
.endpoint { background: var(--card); border: 1px solid var(--border); border-left-width: 4px; border-radius: 8px; margin: 0 0 20px; padding: 14px 18px; scroll-margin-top: calc(var(--top, 90px) + 12px); }
.endpoint.t-added { border-left-color: var(--added); }
.endpoint.t-breaking { border-left-color: var(--breaking); }
.endpoint.t-changed { border-left-color: var(--changed); }
.endpoint .endpoint { margin: 10px 0 0; }
.ep-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.ep-path { font-size: 15px; font-weight: 600; background: none; padding: 0; overflow-wrap: anywhere; }
.endpoint.removed .ep-path { text-decoration: line-through; }
.path-param { color: var(--type); }
.ep-title { font-size: 18px; font-weight: 600; margin: 6px 0 2px; }
.ep-meta { display: flex; flex-wrap: wrap; gap: 4px 16px; color: var(--muted); font-size: 13px; margin-top: 4px; }
.badge { font-size: 12.5px; font-weight: 600; margin-left: auto; }
.badge.t-added { color: var(--added); } .badge.t-breaking { color: var(--breaking); } .badge.t-changed { color: var(--changed); }
.method { font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 1px 6px; border-radius: 4px; color: #fff; background: #6e7781; flex: none; }
.m-get { background: #0969da; } .m-post { background: #1a7f37; } .m-put { background: #9a6700; }
.m-patch { background: #8250df; } .m-delete { background: #cf222e; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.chip { font-size: 12px; border: 1px solid var(--border); border-radius: 999px; padding: 0 8px; color: var(--muted); }
.chip-added { color: var(--added); border-color: var(--added); background: var(--added-bg); }
.chip-removed { color: var(--breaking); border-color: var(--breaking); text-decoration: line-through; }
.banner { margin: 10px 0; padding: 6px 10px; border-radius: 6px; font-weight: 600; }
.banner.t-added { background: var(--added-bg); color: var(--added); }
.banner.t-breaking { background: var(--breaking-bg); color: var(--breaking); }
.banner.t-changed { background: var(--changed-bg); color: var(--changed); }
.md p { margin: 6px 0; }
.md ul, .md ol { margin: 6px 0; padding-left: 22px; }
.md pre { background: var(--code-bg); padding: 8px 10px; border-radius: 6px; overflow-x: auto; }
.md pre code { background: none; padding: 0; }
.md-heading { font-weight: 600; }

/* Digest */
.digest { border: 1px solid var(--border); border-radius: 6px; margin: 12px 0; background: var(--panel); }
.digest-title { font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--border); }
.digest ul, ul.changes { list-style: none; margin: 0; padding: 4px 0; }
.digest li, ul.changes li { display: flex; gap: 6px; padding: 1px 10px; font-size: 13.5px; }
ul.changes { margin: 4px 0; }
ul.changes li { padding: 1px 6px; border-radius: 4px; }
.digest .marker, ul.changes .marker { width: 1.5ch; flex: none; font-family: ui-monospace, monospace; font-weight: 700; }
.digest li.t-added .marker, ul.changes li.t-added .marker { color: var(--added); }
.digest li.t-breaking .marker, ul.changes li.t-breaking .marker { color: var(--breaking); }
.digest li.t-changed .marker, ul.changes li.t-changed .marker { color: var(--changed); }
ul.changes li.t-breaking { background: var(--breaking-bg); }
ul.changes li.t-changed { background: var(--changed-bg); }
.where { font-family: ui-monospace, monospace; font-size: 12.5px; }
.reason { color: var(--breaking); font-size: 12.5px; font-weight: 600; margin-left: 6px; }
.text-diff { border-radius: 6px; padding: 4px 10px; margin: 6px 0; background: var(--panel); border: 1px dashed var(--border); font-size: 13.5px; }
.text-diff > summary { cursor: pointer; color: var(--muted); }
.text-diff.t-changed > summary { color: var(--changed); }
.text-diff.t-breaking > summary { color: var(--breaking); }
.text-diff .diff { white-space: pre-wrap; padding: 4px 0; }
/* Inside an added or removed endpoint, every part is added or removed: the card says it once. */
.endpoint.added .state-tag, .endpoint.removed .state-tag { display: none; }
del { background: var(--breaking-bg); color: var(--breaking); text-decoration: line-through; }
ins { background: var(--added-bg); color: var(--added); text-decoration: none; }

/* Sections and parts */
.ep-section { margin-top: 18px; }
.ep-section h4 { font-size: 15px; margin: 0 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
h5 { font-size: 13px; margin: 12px 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.tag { font-size: 11.5px; font-weight: 600; border-radius: 4px; padding: 0 6px; margin-left: 6px; border: 1px solid var(--border); color: var(--muted); text-transform: none; letter-spacing: 0; vertical-align: middle; }
.tag.t-added { color: var(--added); border-color: var(--added); background: var(--added-bg); }
.tag.t-breaking { color: var(--breaking); border-color: var(--breaking); background: var(--breaking-bg); }
.tag.t-changed { color: var(--changed); border-color: var(--changed); background: var(--changed-bg); }
.required { color: var(--breaking); font-size: 11.5px; font-weight: 600; margin-left: 6px; text-transform: none; letter-spacing: 0; }
.type { color: var(--type); font-size: 13px; }
.fact { font-size: 12px; color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; white-space: nowrap; }
.detail { font-size: 13px; color: var(--muted); }
.table-wrap { overflow-x: auto; }
table.params { border-collapse: collapse; width: 100%; min-width: 560px; font-size: 14px; table-layout: fixed; }
.params col.c-name { width: 26%; }
.params col.c-type { width: 22%; }
.params th { text-align: left; font-size: 12px; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--border); padding: 4px 8px; }
.params td { vertical-align: top; border-bottom: 1px solid var(--border); padding: 6px 8px; overflow-wrap: anywhere; }
.params .p-name .state-tag { display: table; margin: 4px 0 0; white-space: normal; }
.params .p-desc .md p:first-child { margin-top: 0; }
.params tr.sub td { padding: 0 8px 8px; }
tr.st-added td:first-child, .st-added > .media-head, .st-added > .resp-head { box-shadow: inset 3px 0 var(--added); }
tr.st-removed td:first-child, .st-removed > .media-head, .st-removed > .resp-head { box-shadow: inset 3px 0 var(--breaking); }
tr.st-changed.t-changed td:first-child { box-shadow: inset 3px 0 var(--changed); }
tr.st-changed.t-breaking td:first-child { box-shadow: inset 3px 0 var(--breaking); }
tr.st-removed code, .scheme.st-removed code { text-decoration: line-through; }
tr.t-added td { background: color-mix(in srgb, var(--added-bg) 60%, transparent); }
tr.st-removed td { background: color-mix(in srgb, var(--breaking-bg) 60%, transparent); }
.block { margin: 10px 0; }
.response { border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; }
.response.st-added { border-color: var(--added); }
.response.st-removed { border-color: var(--breaking); }
.resp-head, .media-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding-left: 6px; }
.code { font-weight: 700; font-size: 13px; padding: 1px 7px; border-radius: 4px; color: #fff; background: #6e7781; }
.c-2xx { background: #1a7f37; } .c-3xx { background: #0969da; } .c-4xx { background: #9a6700; } .c-5xx { background: #cf222e; }
.media { margin: 8px 0 4px; }
.media-head code { font-weight: 600; }
.auth { list-style: none; padding: 0; margin: 0; }
.auth > li.or { color: var(--muted); font-size: 12px; text-transform: uppercase; padding: 2px 0; }
.and { color: var(--muted); font-size: 12px; }
.scheme { padding: 4px 0; }
.flows { margin: 2px 0; padding-left: 20px; font-size: 13px; }
.callback { margin: 10px 0; }

/* Schema lines */
.schema { margin: 4px 0; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); overflow-x: auto; }
details.schema > summary { cursor: pointer; padding: 4px 10px; font-size: 13px; color: var(--muted); }
.lines { font-size: 12.5px; padding: 6px 0; min-width: max-content; }
.line { display: flex; }
.line .marker { width: 3ch; flex: none; text-align: center; user-select: none; }
.line .text { padding-left: calc(var(--depth) * 2ch); white-space: pre-wrap; padding-right: 10px; }
.line.t-added { background: var(--added-bg); }
.line.t-breaking { background: var(--breaking-bg); }
.line.t-changed { background: var(--changed-bg); }
.line.t-added > .marker { color: var(--added); }
.line.t-breaking > .marker { color: var(--breaking); }
.line.t-changed > .marker { color: var(--changed); }
.s-bold { font-weight: 700; }
.s-dim { color: var(--muted); }
.s-type { color: var(--type); }
.s-warning { color: var(--warning); }
.s-added { color: var(--added); }
.s-breaking { color: var(--breaking); }
.s-changed { color: var(--changed); }
.s-added .s-dim, .s-breaking .s-dim, .s-changed .s-dim, .s-added .s-type, .s-breaking .s-type, .s-changed .s-type { color: inherit; }

/* Changed only: hide the unchanged endpoints, and the headings and documents that hold nothing else. */
.empty { color: var(--muted); }
body:not(.show-all) main > .doc.unchanged,
body:not(.show-all) .doc > .unchanged,
body:not(.show-all) .sidebar .unchanged { display: none; }
body.show-all .empty { display: none; }

@media (max-width: 760px) {
  .page { display: block; }
  .top { position: static; }
  .sidebar { position: static; max-height: 40vh; border-right: 0; border-bottom: 1px solid var(--border); }
  main { padding: 16px; }
  .endpoint { padding: 12px; scroll-margin-top: 12px; }
  /* Table rows stack: name and type on one line, the description below. */
  table.params { min-width: 0; table-layout: auto; }
  .params thead { display: none; }
  .params tr, .params td { display: block; }
  .params tr { border-bottom: 1px solid var(--border); padding: 4px 0; }
  .params td { border: 0; padding: 2px 8px; }
  .params td.p-name, .params td.p-type { display: inline-block; }
}
`;

export const SCRIPT = `
(() => {
  const body = document.body;
  const buttons = document.querySelectorAll('[data-show]');
  const select = (mode) => {
    body.classList.toggle('show-all', mode === 'all');
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.show === mode)));
  };
  buttons.forEach((b) => b.addEventListener('click', () => select(b.dataset.show)));
  select(body.classList.contains('show-all') ? 'all' : 'changed');

  // The sticky header height, so the sidebar and anchors sit below it.
  const top = document.querySelector('.top');
  const measure = () => document.documentElement.style.setProperty('--top', top.offsetHeight + 'px');
  new ResizeObserver(measure).observe(top);

  // The filter hides sidebar entries that do not match, and groups left empty.
  const search = document.querySelector('.search');
  search.addEventListener('input', () => {
    const words = search.value.toLowerCase().split(/\\s+/).filter(Boolean);
    document.querySelectorAll('.sidebar li[data-search]').forEach((li) => {
      li.classList.toggle('no-match', !words.every((word) => li.dataset.search.includes(word)));
    });
    document.querySelectorAll('.nav-group').forEach((group) => {
      group.classList.toggle('no-match', group.querySelector('li:not(.no-match)') === null);
    });
  });

  // Mark the sidebar entry of the endpoint at the top of the view.
  const links = new Map();
  document.querySelectorAll('.sidebar a[href^="#endpoint-"]').forEach((a) => links.set(a.getAttribute('href').slice(1), a));
  let current;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      current?.classList.remove('current');
      current = links.get(entry.target.id);
      current?.classList.add('current');
    }
  }, { rootMargin: '-120px 0px -70% 0px' });
  document.querySelectorAll('.endpoint[id]').forEach((el) => observer.observe(el));
})();
`;
