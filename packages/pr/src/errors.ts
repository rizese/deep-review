/**
 * What kind of failure something was, so a caller can decide what to do
 * about it rather than parse a message. Four kinds cover every retry
 * policy we want:
 *
 * - `transient`: the world hiccuped — a socket reset, a 5xx, a rate limit.
 *   Try again later; nothing about the request was wrong.
 * - `config`: this machine is not set up — no token, a bad key, git cannot
 *   authenticate. Retrying is pointless until someone fixes it.
 * - `input`: the PR itself cannot be processed — an empty diff, one too
 *   large for the model. Retrying the same input gives the same answer.
 * - `build`: our own pipeline failed — a slicer result that would not
 *   validate, an analysis crash. Worth one more try (model output is not
 *   deterministic); after that, wait for the code to change.
 *
 * Errors thrown by this codebase carry the kind on themselves; errors from
 * libraries and the platform are classified by shape in `failureKindOf`.
 */

export type FailureKind = "transient" | "config" | "input" | "build";

export class DeepReviewError extends Error {
  readonly kind: FailureKind;
  constructor(kind: FailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.kind = kind;
  }
}

export class TransientError extends DeepReviewError {
  /** When the other side said to come back, in milliseconds from now. */
  readonly retryAfterMs: number | undefined;
  constructor(message: string, options?: { cause?: unknown; retryAfterMs?: number | undefined }) {
    super("transient", message, options);
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export class ConfigError extends DeepReviewError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("config", message, options);
  }
}

export class InputError extends DeepReviewError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("input", message, options);
  }
}

export class BuildError extends DeepReviewError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("build", message, options);
  }
}

/** Node/undici error codes that mean the network, not the request, failed. */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * The kind of an arbitrary thrown value, walking its `cause` chain. Our own
 * errors answer for themselves. Library errors are read by shape: an HTTP
 * status (`status` or `statusCode`, as fetch responses and the AI SDK's
 * APICallError spell it), an `isRetryable` flag, an undici code, or the two
 * messages undici uses for a connection that died mid-flight. Anything
 * unrecognised is a build failure — the conservative answer, since it
 * gets one retry and then waits for a code change.
 */
export function failureKindOf(error: unknown): FailureKind {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof DeepReviewError) return current.kind;
    const e = current as {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      isRetryable?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const status = typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : null;
    if (status !== null) {
      if (status === 429 || status >= 500) return "transient";
      if (status === 401 || status === 403) return "config";
      if (status === 404) return "config";
      if (status >= 400) return "input";
    }
    if (e.isRetryable === true) return "transient";
    if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return "transient";
    if (typeof e.message === "string" && /^(fetch failed|terminated)$/i.test(e.message.trim()) && !e.cause) {
      return "transient";
    }
    current = e.cause;
  }
  return "build";
}

/** A message for a log line or an index row: the error's own, or the value as text. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
