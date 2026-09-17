import { describe, expect, it } from "vitest";
import type { PrView } from "@deep-review/review/api";
import { badgeText, isUnread, unreadCount } from "./unread.js";

function pr(over: Partial<PrView>): PrView {
  return {
    owner: "o",
    repo: "r",
    number: 1,
    key: "o/r#1",
    prUrl: "https://github.com/o/r/pull/1",
    path: "/pr/o/r/1/",
    state: "ready",
    role: "review",
    approved: false,
    approvers: [],
    addedAt: 0,
    log: [],
    live: false,
    headSha: "abc",
    ...over,
  } as PrView;
}

describe("unread", () => {
  it("counts built PRs waiting on you that have not been opened", () => {
    expect(isUnread(pr({}), {})).toBe(true);
    expect(isUnread(pr({}), { "o/r#1": "abc" })).toBe(false);
  });

  it("makes a PR new again when its head moves after it was opened", () => {
    expect(isUnread(pr({ headSha: "def" }), { "o/r#1": "abc" })).toBe(true);
  });

  it("leaves out your own PRs, approved ones and anything not built", () => {
    expect(isUnread(pr({ role: "authored" }), {})).toBe(false);
    expect(isUnread(pr({ approved: true }), {})).toBe(false);
    expect(isUnread(pr({ state: "building" }), {})).toBe(false);
    expect(isUnread(pr({ state: "failed" }), {})).toBe(false);
  });

  it("treats a build without a head commit as seen once opened", () => {
    expect(isUnread(pr({ headSha: undefined }), { "o/r#1": "" })).toBe(false);
    expect(isUnread(pr({ headSha: undefined }), {})).toBe(true);
  });

  it("sums, and shows nothing for zero", () => {
    expect(unreadCount([pr({}), pr({ key: "o/r#2", approved: true }), pr({ key: "o/r#3" })], { "o/r#3": "abc" })).toBe(1);
    expect(badgeText(0)).toBe("");
    expect(badgeText(3)).toBe("3");
  });
});
