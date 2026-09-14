/**
 * The two pages the server renders itself, rather than from a slicing run:
 * the index of every PR it holds, and the placeholder a PR's own URL shows
 * while it is still being built. Both poll the server, so a PR added from
 * another terminal appears without a reload, and a building one turns into
 * its explorer as soon as it is ready.
 */

import {
  CHROME_CSS,
  CHROME_JS,
  THEME_HEAD_JS,
  escapeHtml as esc,
  renderChrome,
  renderSizeBreakdown,
  REPORT_CSS,
  SIZE_CSS,
} from "@deep-review/call-graph";
import type { PrView } from "./registry.js";

const INDEX_CSS = `
  /* The bar runs the width of the window on every page; only the content
     below it is a column, the same way the explorer's sidebar and stage sit
     under a full-width bar. */
  body { max-width: none; padding: 0; }
  .page { max-width: 60rem; margin: 0 auto; padding: 0 1rem 4rem; }
  .building-page .page { max-width: 44rem; }
  header h1 { margin: 0 0 0.2rem; font-size: 1.3rem; }
  .rows { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1.25rem; }
  .row { display: grid; grid-template-columns: 1fr auto; gap: 0.75rem 1rem; align-items: start;
         padding: 0.8rem 0.9rem; border: 1px solid var(--line-c); border-radius: 8px;
         background: var(--panel); }
  .row { cursor: pointer; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
  .row:hover { border-color: var(--accent); box-shadow: 0 6px 20px var(--glass-shadow); }
  .row.failed { border-color: var(--del-edge); }
  .gh { display: inline-flex; width: 1.7rem; height: 1.7rem; align-items: center; justify-content: center;
        border-radius: 50%; color: var(--ink-soft); }
  .gh:hover { color: var(--ink); background: var(--accent-soft); }
  .gh svg { width: 1.05rem; height: 1.05rem; fill: currentColor; }
  /* The tabs and the approved filter hide rows with the hidden attribute; the
     grid display above would otherwise beat the browser's own [hidden] rule. */
  .row[hidden] { display: none; }
  .row .name { font-family: var(--mono); font-size: 0.85rem; color: var(--ink-soft); }
  .row .title { font-weight: 600; letter-spacing: -0.01em; }
  .row a.title { color: inherit; text-decoration: none; }
  .row a.title:hover { color: var(--accent); }
  .row .facts { color: var(--ink-soft); font-size: 0.85rem; margin-top: 0.15rem; }
  .row .delta { margin-top: 0.45rem; max-width: 30rem; }
  .row .delta-text { font-size: 0.75rem; }
  .row .why { color: var(--del-edge); font-size: 0.85rem; margin-top: 0.15rem; }
  .row .last { font-family: var(--mono); font-size: 0.78rem; color: var(--ink-faint);
               margin-top: 0.3rem; white-space: pre-wrap; }
  .side-actions { display: flex; align-items: center; gap: 0.5rem; }
  .pill { font-size: 0.72rem; letter-spacing: 0.03em; text-transform: uppercase;
          padding: 0.15rem 0.5rem; border-radius: 999px; border: 1px solid var(--line-c);
          color: var(--ink-soft); background: var(--panel-2); white-space: nowrap; }
  .pill.ready { color: var(--add-edge); border-color: var(--add-edge); background: var(--add-bg); }
  .pill.failed { color: var(--del-edge); border-color: var(--del-edge); background: var(--del-bg); }
  .pill.building, .pill.queued { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
  .pill.approved { color: var(--add-edge); border-color: var(--add-edge); }
  .pill.draft { color: var(--ink-faint); border-style: dashed; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem;
             flex-wrap: wrap; margin-top: 0.75rem; border-bottom: 1px solid var(--line-c); }
  .tabs { display: flex; gap: 0.25rem; }
  .tab { padding: 0.5rem 0.9rem; cursor: pointer; border: 0; border-bottom: 2px solid transparent;
         margin-bottom: -1px; background: none; color: var(--ink-soft); font: inherit; font-weight: 600; }
  .tab:hover { color: var(--ink); }
  .tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); }
  .tab .count { font-family: var(--mono); font-weight: 400; font-size: 0.78rem; color: var(--ink-soft);
                margin-left: 0.35rem; }
  .toggle { display: flex; align-items: center; gap: 0.4rem; color: var(--ink-soft); font-size: 0.85rem;
            cursor: pointer; user-select: none; padding: 0.5rem 0; }
  .toggle input { accent-color: var(--accent); margin: 0; }
  .rows { margin-top: 1rem; }
  .dot { display: inline-block; width: 0.45rem; height: 0.45rem; border-radius: 50%;
         background: var(--add-edge); }
  .forget { padding: 0.2rem 0.55rem; cursor: pointer; border: 1px solid var(--line-c);
            border-radius: 6px; background: var(--panel); color: var(--ink-faint); font: inherit;
            font-size: 0.78rem; }
  .forget:hover { color: var(--del-edge); border-color: var(--del-edge); }
  .empty { margin-top: 1.5rem; padding: 1.5rem; border: 1px dashed var(--line-c);
           border-radius: 8px; color: var(--ink-soft); }
  .empty code, .hint code { font-family: var(--mono); color: var(--ink); }
  .hint { margin-top: 1.5rem; color: var(--ink-soft); font-size: 0.85rem; }
  .building-page .log { margin-top: 1rem; padding: 0.9rem; border: 1px solid var(--line-c);
                        border-radius: 8px; background: var(--panel); font-family: var(--mono);
                        font-size: 0.8rem; white-space: pre-wrap; color: var(--ink-soft); }
`;

function facts(pr: PrView): string {
  if (pr.state === "ready") {
    return `${pr.slices ?? 0} slices · ${pr.graphs ?? 0} with a walkable call graph`;
  }
  if (pr.state === "failed") return "";
  return "slicing and walking call graphs…";
}

/** The PR's size as core / tests / boilerplate, once there is a build to count. */
function size(pr: PrView): string {
  return pr.state === "ready" && pr.size ? renderSizeBreakdown(pr.size) : "";
}

/** GitHub's mark, inline, for the one link on a card that leaves the app. */
const GITHUB_MARK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;

function row(pr: PrView): string {
  const approvedTitle = pr.approvers.length ? `approved by ${pr.approvers.join(", ")}` : "approved";
  // The whole card opens the PR's page — the explorer when ready, the
  // building page until then — so the title is a link in every state and the
  // card's own click (below, in INDEX_JS) follows it.
  const heading = `<a class="title" href="${esc(pr.path)}">${esc(pr.title ?? pr.key)}</a>`;
  const last = pr.state === "building" ? (pr.log[pr.log.length - 1] ?? "") : "";
  const f = facts(pr);
  return `<div class="row ${pr.state}" data-key="${esc(pr.key)}" data-path="${esc(pr.path)}" data-role="${esc(pr.role)}" data-approved="${pr.approved ? "true" : "false"}">
  <div>
    <div class="name">${esc(pr.key)}${pr.author ? ` · ${esc(pr.author)}` : ""}</div>
    ${heading}
    ${f ? `<div class="facts">${esc(f)}</div>` : ""}
    ${size(pr)}
    ${pr.error ? `<div class="why">${esc(pr.error)}</div>` : ""}
    ${last ? `<div class="last">${esc(last)}</div>` : ""}
  </div>
  <div class="side-actions">
    ${pr.live ? '<span class="dot" title="language services warm"></span>' : ""}
    ${pr.draft ? '<span class="pill draft">draft</span>' : ""}
    ${pr.approved ? `<span class="pill approved" title="${esc(approvedTitle)}">approved</span>` : ""}
    <span class="pill ${pr.state}">${pr.state}</span>
    <a class="gh" href="${esc(pr.prUrl)}" target="_blank" rel="noopener" title="Open on GitHub" aria-label="Open on GitHub">${GITHUB_MARK}</a>
    <button class="forget" type="button" title="Drop this PR from the server">forget</button>
  </div>
</div>`;
}

/**
 * Keeps the list current without a reload: the server is the only renderer
 * of rows, so the poll fetches this same page and swaps the parts that
 * change. "Forget" goes to the server, and the next poll shows the result.
 *
 * The tabs and the "hide approved" box are the page's alone: every row is
 * always rendered, marked with its role and approval, and the page decides
 * which to show. Both choices live in localStorage so they survive the
 * reload a ready PR triggers, and are re-applied after every poll, since the
 * poll replaces the rows wholesale.
 */
const INDEX_JS = `
var TAB_KEY = "deep-review.tab", HIDE_KEY = "deep-review.hideApproved";
function stored(key, fallback) {
  try { var v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* private window; the choice lasts the page */ }
}
var tab = stored(TAB_KEY, "review") === "authored" ? "authored" : "review";
var hideApproved = stored(HIDE_KEY, "false") === "true";

function apply() {
  var rows = document.querySelectorAll(".row");
  var counts = { review: 0, authored: 0 }, hiddenApproved = 0, shown = 0;
  rows.forEach(function (row) {
    var role = row.dataset.role === "authored" ? "authored" : "review";
    counts[role]++;
    var onTab = role === tab;
    var approved = row.dataset.approved === "true";
    var hide = !onTab || (hideApproved && approved);
    row.hidden = hide;
    if (onTab && hideApproved && approved) hiddenApproved++;
    if (!hide) shown++;
  });
  document.querySelectorAll(".tab").forEach(function (button) {
    var name = button.dataset.tab;
    button.setAttribute("aria-selected", name === tab ? "true" : "false");
    button.querySelector(".count").textContent = counts[name] || "";
  });
  var box = document.getElementById("hide-approved");
  if (box) box.checked = hideApproved;
  document.querySelectorAll(".empty").forEach(function (note) {
    var forTab = note.dataset.tab;
    if (!forTab) { note.hidden = rows.length > 0; return; }
    note.hidden = !(forTab === tab && shown === 0 && rows.length > 0);
    var why = note.querySelector(".why-hidden");
    if (why) why.hidden = hiddenApproved === 0;
    if (why) why.textContent = hiddenApproved
      ? hiddenApproved + " approved PR" + (hiddenApproved === 1 ? " is" : "s are") + " hidden."
      : "";
  });
}

function poll() {
  fetch("/", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.text() : null; })
    .then(function (html) {
      if (!html) return;
      var doc = new DOMParser().parseFromString(html, "text/html");
      var rows = doc.querySelector(".rows");
      if (rows) document.querySelector(".rows").innerHTML = rows.innerHTML;
      apply();
    })
    .catch(function () { /* server gone; leave the last list up */ });
}
document.addEventListener("click", function (e) {
  var tabButton = e.target.closest(".tab");
  if (tabButton) {
    tab = tabButton.dataset.tab === "authored" ? "authored" : "review";
    store(TAB_KEY, tab);
    apply();
    return;
  }
  var button = e.target.closest(".forget");
  if (button) {
    var key = button.closest(".row").dataset.key;
    fetch("/prs/" + encodeURIComponent(key), { method: "DELETE" }).then(poll, poll);
    return;
  }
  /* Anywhere else on a card opens its PR; its own links and buttons keep their meaning. */
  var row = e.target.closest(".row");
  if (!row || e.target.closest("a, button, input, label")) return;
  if (e.metaKey || e.ctrlKey) window.open(row.dataset.path, "_blank"); else location.href = row.dataset.path;
});
document.getElementById("hide-approved").addEventListener("change", function (e) {
  hideApproved = e.target.checked;
  store(HIDE_KEY, hideApproved ? "true" : "false");
  apply();
});
apply();
setInterval(poll, 2000);
`;

export function renderIndexPage(prs: PrView[]): string {
  const authored = prs.filter((pr) => pr.role === "authored");
  const review = prs.filter((pr) => pr.role !== "authored");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deep Review — ${prs.length} PR${prs.length === 1 ? "" : "s"}</title>
<style>${REPORT_CSS}${CHROME_CSS}${SIZE_CSS}${INDEX_CSS}</style>
<script>${THEME_HEAD_JS}</script>
</head>
<body>
${renderChrome({ home: "/", count: prs.length })}
<main class="page">
<div class="toolbar">
  <div class="tabs" role="tablist">
    <button class="tab" type="button" role="tab" data-tab="review" aria-selected="true">For review<span class="count">${review.length || ""}</span></button>
    <button class="tab" type="button" role="tab" data-tab="authored" aria-selected="false">My PRs<span class="count">${authored.length || ""}</span></button>
  </div>
  <label class="toggle"><input type="checkbox" id="hide-approved"> Hide approved PRs</label>
</div>
<div class="rows">${prs.map(row).join("\n")}</div>
<div class="empty"${prs.length ? " hidden" : ""}>
  Nothing loaded yet. Add a PR from any terminal:
  <div><code>pr-review https://github.com/owner/repo/pull/123</code></div>
</div>
<div class="empty" data-tab="review" hidden>
  Nothing is waiting on your review. <span class="why-hidden" hidden></span>
</div>
<div class="empty" data-tab="authored" hidden>
  None of your PRs are open here. <span class="why-hidden" hidden></span>
  <div>The watcher adds the PRs you open in each watched repo; <code>pr-review watch --repo owner/repo</code> names one.</div>
</div>
</main>
<script>${CHROME_JS}${INDEX_JS}</script>
</body>
</html>
`;
}

/**
 * What a PR's own URL shows before its build finishes. It watches `/prs`
 * for its own key and reloads into the real explorer the moment it is
 * ready, so a reader can open the link the CLI printed straight away.
 */
export function renderBuildingPage(pr: PrView): string {
  const failed = pr.state === "failed";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pr.key)} — ${failed ? "failed" : "building"}</title>
<style>${REPORT_CSS}${CHROME_CSS}${INDEX_CSS}</style>
<script>${THEME_HEAD_JS}</script>
</head>
<body class="building-page">
${renderChrome({ home: "/" })}
<main class="page">
<header>
  <h1>${esc(pr.title ?? pr.key)}</h1>
  <div class="meta"><a href="${esc(pr.prUrl)}">${esc(pr.key)}</a> · ${failed ? "build failed" : "slicing and walking call graphs…"}</div>
</header>
${pr.error ? `<div class="why">${esc(pr.error)}</div>` : ""}
<div class="log">${esc(pr.log.join("\n")) || "queued…"}</div>
<div class="hint"><a href="/">← every PR on this server</a></div>
</main>
<script>
${CHROME_JS}
var KEY = ${JSON.stringify(pr.key)};
setInterval(function () {
  fetch("/prs", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data) return;
      var mine = data.prs.filter(function (p) { return p.key === KEY; })[0];
      if (!mine) { location.href = "/"; return; }
      /* Ready: the same URL now serves the explorer itself. */
      if (mine.state === "ready") { location.reload(); return; }
      var log = document.querySelector(".log");
      if (log && mine.log) log.textContent = mine.log.join("\\n");
    })
    .catch(function () { /* server gone; nothing to show */ });
}, 1500);
</script>
</body>
</html>
`;
}
