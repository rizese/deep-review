import { fileURLToPath } from "node:url";
import { BuildError, ConfigError, TransientError } from "@deep-review/pr";
import { describe, expect, it } from "vitest";
import { errorOfKind, forkBuild, serializeError } from "./buildFork.js";

const workerPath = fileURLToPath(new URL("./fixtures/fakeBuildWorker.ts", import.meta.url));
const build = forkBuild({ workerPath });
const request = (prUrl: string) => ({ prUrl, navBase: "/pr/a/b/1/", options: {} });

describe("forkBuild", () => {
  it("runs the build in a child, relaying its progress and returning what it built", async () => {
    const log: string[] = [];
    const built = await build(request("https://github.com/a/b/pull/1"), (m) => log.push(m));
    expect(log).toEqual(["first", "second"]);
    expect(built.input.overview).toBe("/pr/a/b/1/");
    expect(built.input.navBase).toBe("/pr/a/b/1/");
    expect([built.headSha, built.baseSha]).toEqual(["h", "b"]);
  });

  it("delivers a build of real size whole, even though the child exits right after sending it", async () => {
    const built = await build(request("https://github.com/a/big/pull/1"), () => {});
    expect(built.input.overview.length).toBe(6 * 1024 * 1024);
  }, 20_000);

  it("brings an error back with its kind intact, so the parent can classify it as the child did", async () => {
    const log: string[] = [];
    await expect(build(request("https://github.com/a/fail/pull/1"), (m) => log.push(m))).rejects.toMatchObject({
      constructor: ConfigError,
      message: "no token for you",
    });
    expect(log).toEqual(["first", "second"]);
  });

  it("reports a child that died without answering as a build failure naming the exit code", async () => {
    await expect(build(request("https://github.com/a/crash/pull/1"), () => {})).rejects.toMatchObject({
      constructor: BuildError,
      message: expect.stringMatching(/exited before finishing \(code 3\)/),
    });
  });

  it("reports a worker that cannot start at all", async () => {
    const broken = forkBuild({ workerPath: "/nonexistent/worker.ts" });
    await expect(broken(request("https://github.com/a/b/pull/1"), () => {})).rejects.toBeInstanceOf(BuildError);
  }, 15_000);
});

describe("error wire form", () => {
  it("round-trips the kind and message", () => {
    const wire = serializeError(new TransientError("later", { retryAfterMs: 5 }));
    expect(wire).toMatchObject({ type: "error", kind: "transient", message: "later" });
    if (wire.type !== "error") throw new Error("unreachable");
    expect(errorOfKind(wire.kind, wire.message)).toBeInstanceOf(TransientError);
    expect(errorOfKind("config", "x")).toBeInstanceOf(ConfigError);
    expect(errorOfKind("build", "x")).toBeInstanceOf(BuildError);
  });
});
