import { describe, expect, it } from "vitest";
import { renderBuildingPage, renderIndexPage } from "./indexPage.js";
import type { PrView } from "./registry.js";

function view(overrides: Partial<PrView> = {}): PrView {
  return {
    owner: "a",
    repo: "b",
    number: 1,
    key: "a/b#1",
    prUrl: "https://github.com/a/b/pull/1",
    state: "ready",
    role: "review",
    approved: false,
    approvers: [],
    path: "/pr/a/b/1/",
    title: "A PR",
    slices: 2,
    graphs: 1,
    addedAt: 0,
    log: [],
    live: false,
    ...overrides,
  };
}

describe("renderIndexPage", () => {
  it("shows a ready PR's size split by kind under its facts", () => {
    const html = renderIndexPage(
      [
        view({
          size: {
            byKind: {
              core: { additions: 120, deletions: 30 },
              test: { additions: 80, deletions: 5 },
              boilerplate: { additions: 0, deletions: 0 },
            },
            total: { additions: 200, deletions: 35 },
          },
        }),
      ]);
    const row = /<div class="row ready"[\s\S]*?<div class="side-actions">/.exec(html)![0];
    expect(row).toContain("2 slices · 1 with a walkable call graph");
    expect(row).toContain(
      '<span class="kind">core</span> <span class="plus">+120</span><span class="minus">−30</span>',
    );
    expect(row).toContain(
      '<span class="kind">tests</span> <span class="plus">+80</span><span class="minus">−5</span>',
    );
    expect(row).not.toContain("boilerplate");
    // The bar's styles ride along, since the explorer's stylesheet does not.
    expect(html).toContain(".delta .core { --kind-color");
  });

  it("shows one unsplit total for a PR whose report predates kinds", () => {
    const html = renderIndexPage(
      [view({ size: { byKind: null, total: { additions: 7, deletions: 2 } } })]);
    expect(html).toContain(
      '<span class="delta-kind unclassified"><span class="plus">+7</span><span class="minus">−2</span></span>',
    );
    expect(html).not.toContain('<span class="kind">');
  });

  it("shows no size while a PR is still building, or when it changed nothing", () => {
    const building = renderIndexPage([view({ state: "building", size: undefined })]);
    expect(building).not.toContain('class="delta"');
    const empty = renderIndexPage(
      [view({ size: { byKind: null, total: { additions: 0, deletions: 0 } } })]);
    expect(empty).not.toContain('class="delta"');
  });
});

/** Every inline script of a rendered page, so a test can ask the engine to parse it. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

describe("page scripts", () => {
  it("parse — a regex with a slash inside a template literal once broke every button on the index", () => {
    const pages = [renderIndexPage([view(), view({ key: "a/b#2", number: 2, state: "failed", error: "x" })]), renderBuildingPage(view({ state: "building" }))];
    for (const html of pages) {
      const scripts = inlineScripts(html);
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) expect(() => new Function(script)).not.toThrow();
    }
  });
});

describe("renderIndexPage tabs and approval", () => {
  it("offers a tab per role, counted, and a box to hide approved PRs", () => {
    const html = renderIndexPage(
      [view(), view({ key: "a/b#2", number: 2, role: "authored" }), view({ key: "a/b#3", number: 3, role: "authored" })]);
    expect(html).toContain('data-tab="review" aria-selected="true">For review<span class="count">1</span>');
    expect(html).toContain('data-tab="authored" aria-selected="false">My PRs<span class="count">2</span>');
    expect(html).toContain('<input type="checkbox" id="hide-approved"> Hide approved PRs');
  });

  it("marks every row with its role and approval, so the page can filter without asking the server", () => {
    const html = renderIndexPage(
      [
        view({ approved: true, approvers: ["alex", "sam"] }),
        view({ key: "a/b#2", number: 2, role: "authored", draft: true, author: "me" }),
      ]);
    expect(html).toContain('data-key="a/b#1" data-path="/pr/a/b/1/" data-role="review" data-approved="true"');
    expect(html).toContain('<span class="pill approved" title="approved by alex, sam">approved</span>');
    expect(html).toContain('data-key="a/b#2" data-path="/pr/a/b/1/" data-role="authored" data-approved="false"');
    expect(html).toContain('<span class="pill draft">draft</span>');
    expect(html).toContain('<div class="name">a/b#2 · me</div>');
  });

  it("lets the page hide a row, despite the row's own display", () => {
    // `.row` is a grid, and an author display beats the browser's [hidden]
    // rule — so without this, every tab showed every PR.
    expect(renderIndexPage([view()])).toContain(".row[hidden] { display: none; }");
  });

  it("makes the whole card the way into the PR, and keeps GitHub to one icon", () => {
    const html = renderIndexPage([view(), view({ key: "a/b#2", number: 2, state: "building", path: "/pr/a/b/2/" })]);
    // The card carries its path for the click handler; the title links there in every state.
    expect(html).toContain('data-key="a/b#1" data-path="/pr/a/b/1/"');
    expect(html).toContain('data-key="a/b#2" data-path="/pr/a/b/2/"');
    expect(html).toContain('<a class="title" href="/pr/a/b/2/">');
    // The key is text, not a link out; GitHub is the icon in the action row.
    expect(html).toContain('<div class="name">a/b#1</div>');
    expect(html).not.toContain('<a href="https://github.com/a/b/pull/1">');
    expect(html).toContain('<a class="gh" href="https://github.com/a/b/pull/1" target="_blank" rel="noopener" title="Open on GitHub"');
    expect(html).toContain("e.target.closest(\"a, button, input, label\")");
  });

  it("sits in the shared chrome, with the count and the way home", () => {
    const html = renderIndexPage([view(), view({ key: "a/b#2", number: 2 })]);
    expect(html).toContain('<nav class="chrome"');
    expect(html).toContain('<a class="glass brand" href="/"');
    expect(html).toContain('<span class="count" title="PRs on this server">2</span>');
    expect(html).not.toContain("<h1>Deep Review</h1>");
  });

  it("renders a PR that predates roles as one for review, not approved", () => {
    const html = renderIndexPage([view()]);
    expect(html).toContain('data-role="review" data-approved="false"');
    expect(html).not.toContain('class="pill approved"');
  });
});
