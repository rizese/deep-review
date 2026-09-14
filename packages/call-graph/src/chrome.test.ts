import { describe, expect, it } from "vitest";
import { CHROME_CSS, renderChrome } from "./chrome.js";

describe("renderChrome", () => {
  it("makes the wordmark the way home when a server stands behind the page", () => {
    const html = renderChrome({ home: "/", count: 4 });
    expect(html).toContain('<a class="glass brand" href="/"');
    expect(html).toContain('class="wordmark" role="img" aria-label="Deep Review"');
    expect(html).toContain('<span class="count" title="PRs on this server">4</span>');
    expect(html).toContain('<button class="add"');
    // An icon, not a character: the glyph is an SVG, and the X takes over while the field is open.
    expect(html).toContain('<svg class="ic-plus"');
    expect(html).toContain('<svg class="ic-close"');
    expect(html).not.toMatch(/aria-expanded="false">\s*\+/);
  });

  it("shows the wordmark alone, unlinked, on a static copy with no server", () => {
    const html = renderChrome({ home: null });
    expect(html).toContain('<span class="glass brand">');
    expect(html).not.toContain("<a ");
    expect(html).not.toContain('class="tools"');
    expect(renderChrome()).toBe(html);
  });

  it("offers light, system and dark on every page, server or not", () => {
    for (const html of [renderChrome({ home: "/" }), renderChrome()]) {
      expect(html).toContain('<button type="button" data-theme="light"');
      expect(html).toContain('<button type="button" data-theme="system"');
      expect(html).toContain('<button type="button" data-theme="dark"');
    }
  });

  it("lets the browser morph the bar between pages instead of repainting it", () => {
    expect(CHROME_CSS).toContain("@view-transition { navigation: auto; }");
    // Or the snapshot layer swallows the first click after every navigation.
    expect(CHROME_CSS).toContain("::view-transition { pointer-events: none; }");
    for (const name of ["chrome-brand", "chrome-tools", "chrome-theme"]) {
      expect(CHROME_CSS).toContain(`view-transition-name: ${name};`);
    }
    // The compact bar is a body class, so the page grid that reads --chrome-h follows it.
    expect(CHROME_CSS).toContain(".compact { --chrome-h: 2.5rem; }");
  });

  it("carries the wordmark inline, so a static copy needs no asset route", () => {
    expect(CHROME_CSS).toContain('mask: url("data:image/png;base64,');
    // The backdrop is the page's, not the bar's: grain over a gradient.
    expect(CHROME_CSS).toContain("feTurbulence");
    // Encoded exactly once, or the filter reference breaks and the grain is a black sheet.
    expect(CHROME_CSS).toContain("filter%3D'url(%23g)'");
    expect(CHROME_CSS).not.toContain("%2523");
    expect(CHROME_CSS).toContain("background: var(--pool) fixed;");
    // The URL field waits behind the "+": flex display must not beat [hidden].
    expect(CHROME_CSS).toContain(".chrome .add-form[hidden] { display: none; }");
  });
});
