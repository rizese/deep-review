import { describe, expect, it } from "vitest";
import { BuildError, ConfigError, failureKindOf, InputError, TransientError } from "./errors.js";

describe("failureKindOf", () => {
  it("lets our own errors answer for themselves, through a cause chain", () => {
    expect(failureKindOf(new TransientError("x"))).toBe("transient");
    expect(failureKindOf(new ConfigError("x"))).toBe("config");
    expect(failureKindOf(new InputError("x"))).toBe("input");
    expect(failureKindOf(new BuildError("x"))).toBe("build");
    expect(failureKindOf(new Error("wrapped", { cause: new ConfigError("inner") }))).toBe("config");
    expect(new TransientError("x", { retryAfterMs: 500 }).retryAfterMs).toBe(500);
    expect(new ConfigError("x").name).toBe("ConfigError");
  });

  it("reads undici's network failures as transient", () => {
    // What node's fetch throws when the socket drops: a TypeError with a coded cause.
    const reset = new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    expect(failureKindOf(reset)).toBe("transient");
    expect(failureKindOf(new TypeError("terminated"))).toBe("transient");
    expect(failureKindOf(Object.assign(new Error("getaddrinfo"), { code: "EAI_AGAIN" }))).toBe("transient");
  });

  it("reads HTTP statuses the way a retry policy needs", () => {
    const withStatus = (statusCode: number) => Object.assign(new Error("api"), { statusCode });
    expect(failureKindOf(withStatus(429))).toBe("transient");
    expect(failureKindOf(withStatus(503))).toBe("transient");
    expect(failureKindOf(withStatus(401))).toBe("config");
    expect(failureKindOf(withStatus(404))).toBe("config");
    expect(failureKindOf(withStatus(422))).toBe("input");
    // The AI SDK's APICallError carries its own verdict.
    expect(failureKindOf(Object.assign(new Error("api"), { isRetryable: true }))).toBe("transient");
  });

  it("treats anything unrecognised as a build failure, and survives cycles and non-errors", () => {
    expect(failureKindOf(new Error("slices did not partition the diff"))).toBe("build");
    expect(failureKindOf("a string")).toBe("build");
    expect(failureKindOf(null)).toBe("build");
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(failureKindOf(a)).toBe("build");
  });
});
