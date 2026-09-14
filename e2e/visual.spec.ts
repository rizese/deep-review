import { expect, test, type Page } from "@playwright/test";

/**
 * Pick the theme before the page paints, as the bar's switcher would have —
 * and turn the film grain off. The grain is noise, so with it every
 * baseline is a megabyte of incompressible pixels; without it the layout
 * and colours are tested just the same and a baseline is a tenth the size.
 */
async function theme(page: Page, choice: "light" | "dark"): Promise<void> {
  await page.addInitScript((t) => {
    localStorage.setItem("deep-review.theme", t);
    document.addEventListener("DOMContentLoaded", () => document.documentElement.style.setProperty("--grain", "0"));
  }, choice);
}

/** The index, settled: four cards, the failed one showing its reason. */
async function openIndex(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".row")).toHaveCount(4);
  await expect(page.locator(".row.failed .why")).toContainText("GITHUB_TOKEN");
}

test.describe("index", () => {
  test("light", async ({ page }) => {
    await theme(page, "light");
    await openIndex(page);
    await expect(page).toHaveScreenshot("index-light.png", { fullPage: true });
  });

  test("dark", async ({ page }) => {
    await theme(page, "dark");
    await openIndex(page);
    await expect(page).toHaveScreenshot("index-dark.png", { fullPage: true });
  });

  test("my PRs tab, with approved hidden", async ({ page }) => {
    await theme(page, "light");
    await openIndex(page);
    await page.getByRole("tab", { name: /My PRs/ }).click();
    await expect(page.locator(".row:visible")).toHaveCount(2);
    await expect(page).toHaveScreenshot("index-my-prs.png", { fullPage: true });
    await page.getByRole("tab", { name: /For review/ }).click();
    await page.getByLabel("Hide approved PRs").check();
    await expect(page.locator(".row:visible")).toHaveCount(1);
    await expect(page).toHaveScreenshot("index-hide-approved.png", { fullPage: true });
  });

  test("add-by-URL field open", async ({ page }) => {
    await theme(page, "light");
    await openIndex(page);
    await page.getByRole("button", { name: "Add a PR by URL" }).click();
    await expect(page.locator(".chrome .add-form")).toBeVisible();
    await expect(page.locator(".chrome")).toHaveScreenshot("chrome-add-open.png");
  });
});

test.describe("building page", () => {
  test("shows the build log while it waits", async ({ page }) => {
    await theme(page, "light");
    await page.goto("/pr/acme/widgets/3/");
    await expect(page.locator(".log")).toContainText("thinking");
    await expect(page).toHaveScreenshot("building.png", { fullPage: true });
  });
});

test.describe("explorer", () => {
  async function openExplorer(page: Page): Promise<void> {
    await page.goto("/pr/acme/widgets/1/");
    await expect(page.locator(".slice-view").first()).toBeVisible();
    await expect(page.locator(".scope-bar").first()).toBeVisible();
  }

  test("light", async ({ page }) => {
    await theme(page, "light");
    await openExplorer(page);
    await expect(page).toHaveScreenshot("explorer-light.png");
  });

  test("dark", async ({ page }) => {
    await theme(page, "dark");
    await openExplorer(page);
    await expect(page).toHaveScreenshot("explorer-dark.png");
  });

  test("folded code pane", async ({ page }) => {
    await theme(page, "light");
    await openExplorer(page);
    const bar = page.locator(".scope-bar").first();
    await bar.click();
    await expect(bar).toHaveAttribute("aria-expanded", "false");
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot("explorer-folded.png");
  });

  test("PR description view", async ({ page }) => {
    await theme(page, "light");
    await openExplorer(page);
    await page.getByRole("button", { name: "PR Description" }).click();
    await expect(page.locator(".doc-view")).toBeVisible();
    await expect(page).toHaveScreenshot("explorer-description.png");
  });
});
