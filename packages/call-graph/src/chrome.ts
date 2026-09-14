/**
 * The frame every page of the app sits in: the pool.
 *
 * A light-blue, grainy gradient behind everything, and one glass bar along
 * the top carrying the wordmark — the way home from any page — and, when a
 * navigation server is behind the page, a pill with how many PRs it holds
 * and a "+" that adds one by URL. The static copy `--out` writes has no
 * server, so it gets the wordmark alone, unlinked: there is nowhere to go.
 *
 * The theme tokens live in `html.ts` with the rest of the shared CSS; what
 * is here is only what the frame adds on top: the backdrop, the bar, and the
 * offsets a page needs to sit below it (`--chrome-h`).
 */

import { escapeHtml as esc } from "./highlight.js";
import { WORDMARK_ASPECT, WORDMARK_PNG } from "./wordmark.js";

/**
 * Film grain as a tiling SVG: fractal noise through a colour matrix that
 * keeps only its alpha, so the gradient underneath shows through the grain
 * rather than being replaced by grey. Small enough to inline; tiled by the
 * browser.
 */
const GRAIN_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'>` +
      `<filter id='g' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='3' stitchTiles='stitch'/>` +
      `<feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.9 -0.15'/></filter>` +
      // A plain '#' here: encodeURIComponent turns it into %23 once. Written
      // pre-encoded it came out %2523, the filter reference broke, and the
      // rect painted flat black over the whole pool.
      `<rect width='100%' height='100%' filter='url(#g)'/></svg>`,
  );

export const CHROME_CSS = `
  :root { --chrome-h: 4rem; }
  html {
    min-height: 100%;
    background: var(--pool) fixed;
  }
  body { background: transparent; position: relative; }
  /* The grain sits over the gradient and under the page, fixed so scrolling
     does not turn it into a moving texture. */
  body::before {
    content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background: url("${GRAIN_SVG}") repeat; background-size: 180px 180px;
    opacity: var(--grain, 0.55);
  }

  /* Moving between pages is a real navigation, so the bar's change of size
     — tall on the index, compact over a PR — is animated by the browser's
     cross-document view transition: each pill is named, and the browser
     morphs the old one into the new rather than painting a fresh bar. */
  @view-transition { navigation: auto; }
  /* While the transition plays, the browser covers the page with its
     snapshots — and by default they take the pointer, so the first click
     after every navigation landed on a picture of the page. Let it through. */
  ::view-transition { pointer-events: none; }
  ::view-transition-old(root), ::view-transition-new(root) { animation-duration: 0.22s; }
  ::view-transition-group(chrome-brand), ::view-transition-group(chrome-tools), ::view-transition-group(chrome-theme) {
    animation-duration: 0.32s; animation-timing-function: cubic-bezier(0.32, 0.72, 0, 1);
  }
  .chrome .brand { view-transition-name: chrome-brand; }
  .chrome .tools { view-transition-name: chrome-tools; }
  .chrome .theme { view-transition-name: chrome-theme; }

  .chrome {
    position: sticky; top: 0; z-index: 60;
    display: flex; align-items: center; gap: 0.6rem;
    height: var(--chrome-h); box-sizing: border-box; padding: 0.9rem 1rem 0.5rem;
    transition: height 0.3s ease, padding 0.3s ease;
  }
  /* Compact: over a PR the bar gives the height back to the code. Set on the
     body so the page grid that reads --chrome-h shrinks with it. */
  .compact { --chrome-h: 2.5rem; }
  .compact .chrome { padding: 0.4rem 1rem 0.25rem; gap: 0.45rem; }
  .compact .chrome .glass { padding: 0 0.7rem; gap: 0.5rem; }
  .compact .chrome .wordmark { height: 0.6rem; }
  .compact .chrome .tools { padding: 0 0.25rem 0 0.6rem; gap: 0.25rem; }
  .compact .chrome .count { font-size: 0.68rem; min-width: 1.25rem; padding: 0.05rem 0.3rem; }
  .compact .chrome .add, .compact .chrome .theme button { height: 1.3rem; min-width: 1.3rem; }
  .compact .chrome .add { width: 1.3rem; }
  .compact .chrome .add svg { width: 0.75rem; height: 0.75rem; }
  .compact .chrome .theme { padding: 0 0.25rem; }
  .compact .chrome .theme button { font-size: 0.62rem; padding: 0 0.35rem; }
  .compact .chrome .add-form input { padding: 0.15rem 0.5rem; font-size: 0.74rem; }
  .chrome .glass {
    display: inline-flex; align-items: center; gap: 0.7rem; height: 100%;
    padding: 0 1.15rem; border-radius: 999px; color: var(--ink);
    background: linear-gradient(180deg, var(--glass-hi), var(--glass-lo));
    border: 1px solid var(--glass-edge);
    box-shadow: inset 0 1px 0 var(--glass-edge), 0 8px 24px var(--glass-shadow);
    backdrop-filter: blur(12px) saturate(1.2); -webkit-backdrop-filter: blur(12px) saturate(1.2);
    text-decoration: none;
  }
  .chrome a.glass:hover { border-color: #fff; }
  .chrome .wordmark {
    display: block; height: 0.95rem; aspect-ratio: ${WORDMARK_ASPECT};
    background: var(--wordmark, #fff);
    -webkit-mask: url("${WORDMARK_PNG}") center / contain no-repeat;
    mask: url("${WORDMARK_PNG}") center / contain no-repeat;
    filter: drop-shadow(0 1px 1.5px rgba(10, 50, 80, 0.45));
  }
  .chrome .tools { padding: 0 0.5rem 0 0.9rem; gap: 0.4rem; }
  .chrome .count {
    font-family: var(--mono); font-size: 0.82rem; min-width: 1.6rem; text-align: center;
    padding: 0.15rem 0.4rem; border-radius: 999px; background: var(--pressed-bg, #0f2b45); color: var(--pressed-ink, #fff);
  }
  .chrome .add {
    display: inline-flex; align-items: center; justify-content: center;
    width: 1.9rem; height: 1.9rem; border-radius: 50%; border: 0; cursor: pointer;
    background: transparent; color: var(--ink); font: inherit; line-height: 1;
  }
  .chrome .add:hover { background: var(--glass-hi); }
  .chrome .add svg { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
  .chrome .add .ic-close, .chrome .add[aria-expanded="true"] .ic-plus { display: none; }
  .chrome .add[aria-expanded="true"] .ic-close { display: block; }
  .chrome .add-form { display: flex; align-items: center; gap: 0.4rem; }
  .chrome .add-form[hidden] { display: none; }
  .chrome .add-form input {
    width: 22rem; max-width: 50vw; padding: 0.3rem 0.6rem; border-radius: 999px;
    border: 1px solid var(--glass-edge); background: var(--panel); color: var(--ink);
    font: inherit; font-size: 0.82rem;
  }
  .chrome .add-form input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .chrome .add-note { font-size: 0.78rem; color: var(--ink-soft); }
  .chrome .add-note.bad { color: var(--del-edge); }
  .chrome .theme { margin-left: auto; padding: 0 0.35rem; gap: 0.15rem; }
  .chrome .theme button {
    height: 1.9rem; min-width: 1.9rem; padding: 0 0.55rem; border-radius: 999px; border: 0; cursor: pointer;
    background: transparent; color: var(--ink-soft); font: inherit; font-size: 0.78rem; line-height: 1;
  }
  .chrome .theme button:hover { color: var(--ink); }
  .chrome .theme button[aria-pressed="true"] { background: var(--pressed-bg, #0f2b45); color: var(--pressed-ink, #fff); }
`;

/**
 * Runs in <head>, before anything paints: a remembered light or dark choice
 * is stamped on the root at once, so a dark reader never sees a flash of
 * pool-blue on the way in. "system" is the absence of the attribute.
 */
export const THEME_HEAD_JS = `(function(){try{var t=localStorage.getItem("deep-review.theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export interface ChromeOptions {
  /**
   * Where the wordmark leads. Null on a page with no server behind it — a
   * static copy — where the wordmark is a label, not a link, and there is
   * no count to show.
   */
  home?: string | null | undefined;
  /** How many PRs the server holds, when the page renders knowing it. */
  count?: number | undefined;
}

/** The top bar. Same on every page; only what stands behind the page differs. */
export function renderChrome(options: ChromeOptions = {}): string {
  const home = options.home ?? null;
  const mark = `<span class="wordmark" role="img" aria-label="Deep Review"></span>`;
  const brand = home
    ? `<a class="glass brand" href="${esc(home)}" title="Every PR on this server">${mark}</a>`
    : `<span class="glass brand">${mark}</span>`;
  const theme = `<div class="glass theme" role="group" aria-label="Theme">
    <button type="button" data-theme="light" title="Light">☀</button>
    <button type="button" data-theme="system" title="Follow the system">◐</button>
    <button type="button" data-theme="dark" title="Dark">☾</button>
  </div>`;
  const tools = home
    ? `<div class="glass tools">
    <span class="count" title="PRs on this server">${options.count ?? ""}</span>
    <button class="add" type="button" title="Add a PR by URL" aria-label="Add a PR by URL" aria-expanded="false">
      <svg class="ic-plus" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11"/></svg>
      <svg class="ic-close" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
    </button>
    <form class="add-form" hidden>
      <input type="url" name="url" placeholder="https://github.com/owner/repo/pull/123" aria-label="PR URL" required>
      <span class="add-note"></span>
    </form>
  </div>`
    : "";
  return `<nav class="chrome" aria-label="Deep Review">
  ${brand}
  ${tools}
  ${theme}
</nav>`;
}

/**
 * Behind the "+": a URL typed into the bar becomes a PR on the server, and
 * the page moves to it — the building page first, the explorer when ready.
 * The count asks the server rather than trusting the number it was rendered
 * with, since PRs arrive from other terminals and the watcher while a page
 * is open. Harmless on a page with no tools pill: it finds nothing to wire.
 */
export const CHROME_JS = `
(function () {
  var group = document.querySelector(".chrome .theme");
  if (group) {
    var THEME_KEY = "deep-review.theme";
    function current() {
      try { var t = localStorage.getItem(THEME_KEY); return t === "light" || t === "dark" ? t : "system"; } catch (e) { return "system"; }
    }
    function applyTheme(choice) {
      var root = document.documentElement;
      if (choice === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", choice);
      group.querySelectorAll("button").forEach(function (b) {
        b.setAttribute("aria-pressed", b.dataset.theme === choice ? "true" : "false");
      });
    }
    group.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      try { if (b.dataset.theme === "system") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, b.dataset.theme); } catch (err) {}
      applyTheme(b.dataset.theme);
    });
    applyTheme(current());
  }
  var tools = document.querySelector(".chrome .tools");
  if (!tools) return;
  var count = tools.querySelector(".count");
  var add = tools.querySelector(".add");
  var form = tools.querySelector(".add-form");
  var input = form.querySelector("input");
  var note = form.querySelector(".add-note");
  function refresh() {
    fetch("/prs", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (data) count.textContent = data.prs.length; })
      .catch(function () { /* server gone; keep the last number */ });
  }
  /* The count follows the server's own stream of changes; a poll only
     where the browser has no EventSource. */
  var keys = null;
  function listen() {
    var events = new EventSource("/events");
    events.addEventListener("snapshot", function (e) {
      keys = {};
      JSON.parse(e.data).prs.forEach(function (p) { keys[p.key] = true; });
      count.textContent = Object.keys(keys).length;
    });
    events.addEventListener("pr", function (e) {
      if (!keys) return;
      keys[JSON.parse(e.data).pr.key] = true;
      count.textContent = Object.keys(keys).length;
    });
    events.addEventListener("removed", function (e) {
      if (!keys) return;
      delete keys[JSON.parse(e.data).key];
      count.textContent = Object.keys(keys).length;
    });
  }
  add.addEventListener("click", function () {
    form.hidden = !form.hidden;
    add.setAttribute("aria-expanded", form.hidden ? "false" : "true");
    note.textContent = "";
    if (!form.hidden) input.focus();
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var m = /github\\.com\\/([^\\/\\s]+)\\/([^\\/\\s]+)\\/pull\\/(\\d+)/.exec(input.value.trim());
    if (!m) { note.textContent = "not a PR URL"; note.className = "add-note bad"; return; }
    note.textContent = "adding…"; note.className = "add-note";
    fetch("/prs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: m[1], repo: m[2], number: Number(m[3]) }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.pr) { note.textContent = data.why || "the server said no"; note.className = "add-note bad"; return; }
        location.href = data.pr.path;
      })
      .catch(function () { note.textContent = "the server is not answering"; note.className = "add-note bad"; });
  });
  if (window.EventSource) listen();
  else {
    refresh();
    setInterval(refresh, 5000);
  }
})();
`;
