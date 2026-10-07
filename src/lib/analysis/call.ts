import { ANALYSIS_LIMITS } from "@/lib/analysis/limits";
import { ProviderError, type ProviderName } from "@/lib/analysis/provider";
import type { Validated } from "@/lib/analysis/validate";

/**
 * One provider call with the locked rules (D10): a time limit per call;
 * retries (at most 2) only for timeouts, rate limits, server and network
 * errors, with backoff and Retry-After; ONE extra try when the response
 * fails validation; never a retry for other rejections. The run's own
 * signal (whole-run deadline, cancellation) stops everything at once.
 */

export class RunAborted extends Error {
  constructor() {
    super("The analysis was stopped.");
    this.name = "RunAborted";
  }
}

export type CallOptions = {
  timeoutMs: number;
  runSignal: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
  /** Try again after a timeout (default yes; slow local models: no). */
  retryTimeouts?: boolean;
  /** Which provider is called — only used to word the designer's message. */
  provider?: ProviderName;
};

/**
 * What the DESIGNER sees when a call fails (stored as the run's failure
 * reason and shown on Start QC). Never HTTP details, provider error text or
 * validator paths — those go to the server log only (logFailure).
 */
export const DESIGNER_MESSAGES = {
  busy: "Gemini is busy — try again in a few minutes.",
  busyOther: "The analysis service is busy — try again in a few minutes.",
  unreachable: "The analysis service couldn't be reached — try again in a few minutes.",
  unreadable: "The AI's answer couldn't be read — try again.",
  setup: "Analysis isn't set up correctly — tell your admin.",
  timedOut: "The analysis took too long and was stopped.",
} as const;

export function designerMessage(kind: ProviderError["kind"], provider?: ProviderName): string {
  switch (kind) {
    case "rate_limited":
    case "server":
      return provider === "gemini" ? DESIGNER_MESSAGES.busy : DESIGNER_MESSAGES.busyOther;
    case "network":
      return DESIGNER_MESSAGES.unreachable;
    case "timeout":
      return DESIGNER_MESSAGES.timedOut;
    case "invalid_response":
      return DESIGNER_MESSAGES.unreadable;
    case "auth":
    case "rejected":
      return DESIGNER_MESSAGES.setup;
  }
}

/** The technical detail, for the server log only (provider messages never contain the key). */
function logFailure(provider: ProviderName | undefined, kind: string, detail: string) {
  console.error(`Analysis call failed (${provider ?? "provider"}, ${kind}): ${detail.slice(0, 500)}`);
}

const BACKOFF_MS = [2_000, 6_000];
const MAX_RETRY_AFTER_MS = 30_000;
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type CallResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function callProvider<T>(
  call: (signal: AbortSignal) => Promise<string>,
  validate: (raw: string) => Validated<T>,
  options: CallOptions
): Promise<CallResult<T>> {
  const sleep = options.sleep ?? realSleep;
  const retries = options.retries ?? ANALYSIS_LIMITS.maxCallRetries;
  let failures = 0;
  let malformed = 0;
  for (;;) {
    if (options.runSignal.aborted) throw new RunAborted();
    const signal = AbortSignal.any([options.runSignal, AbortSignal.timeout(options.timeoutMs)]);
    try {
      const raw = await call(signal);
      const checked = validate(raw);
      if (checked.ok) return checked;
      if (malformed++ >= 1) {
        logFailure(options.provider, "invalid_response", `invalid analysis response (${checked.reason})`);
        return { ok: false, reason: DESIGNER_MESSAGES.unreadable };
      }
      continue;
    } catch (error) {
      if (options.runSignal.aborted) throw new RunAborted();
      const problem =
        error instanceof ProviderError
          ? error
          : signal.aborted
            ? new ProviderError("The request timed out.", "timeout")
            : new ProviderError("The analysis service couldn't be reached.", "network");
      const retryable = problem.retryable && !(problem.kind === "timeout" && options.retryTimeouts === false);
      if (!retryable || failures >= retries) {
        logFailure(options.provider, problem.kind, problem.message);
        return { ok: false, reason: designerMessage(problem.kind, options.provider) };
      }
      const wait = Math.min(MAX_RETRY_AFTER_MS, problem.retryAfterMs ?? BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]);
      failures++;
      await sleep(wait + Math.floor(Math.random() * 250));
    }
  }
}

/** Runs `tasks` with at most `limit` at a time (3 calls per run; 1 for the local provider). */
export async function inPool<T>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await task(items[index], index);
    }
  });
  await Promise.all(workers);
}
