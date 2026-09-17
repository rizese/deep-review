import { describe, expect, it } from "vitest";
import { findPrUrl, keyOf, mentionsGithub } from "./addByUrl.js";

describe("findPrUrl", () => {
  it("takes a bare PR link apart", () => {
    expect(findPrUrl("https://github.com/spara-ai/spara-app/pull/10816")).toEqual({ owner: "spara-ai", repo: "spara-app", number: 10816 });
  });

  it("finds the link inside a uri-list, a sentence or a files tab URL", () => {
    expect(findPrUrl("https://github.com/o/r/pull/7\r\nhttps://example.com\r\n")?.number).toBe(7);
    expect(findPrUrl("have a look at https://github.com/o/r/pull/7/files when you can")?.number).toBe(7);
    expect(findPrUrl("https://github.com/o/r/pull/7#discussion_r1")?.number).toBe(7);
  });

  it("returns null for text with no PR in it", () => {
    expect(findPrUrl("https://github.com/o/r/issues/7")).toBeNull();
    expect(findPrUrl("https://github.com/o/r")).toBeNull();
    expect(findPrUrl("nothing here")).toBeNull();
    expect(findPrUrl("")).toBeNull();
  });

  it("knows when a paste was at least aimed at GitHub", () => {
    expect(mentionsGithub("https://github.com/o/r/issues/7")).toBe(true);
    expect(mentionsGithub("const x = 1;")).toBe(false);
  });

  it("names a PR the way the server does", () => {
    expect(keyOf({ owner: "o", repo: "r", number: 7 })).toBe("o/r#7");
  });
});
