import { afterEach, describe, expect, it, vi } from "vitest";
import { callProvider, DESIGNER_MESSAGES, designerMessage, inPool, RunAborted } from "@/lib/analysis/call";
import { ProviderError } from "@/lib/analysis/provider";
import type { Validated } from "@/lib/analysis/validate";

/** D10 call rules: time limit, retries only for temporary errors, one retry for an invalid response. */
describe("provider calls", () => {
  // Failures are logged for the server (technical detail) — keep test output quiet.
  const logged = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
  afterEach(() => vi.restoreAllMocks());
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});
  const ok = (raw: string): Validated<string> => (raw === "good" ? { ok: true, value: raw } : { ok: false, reason: "bad shape" });
  const options = (sleeps: number[] = []) => ({ timeoutMs: 50, runSignal: new AbortController().signal, sleep: async (ms: number) => void sleeps.push(ms) });

  it("returns a valid response", async () => {
    expect(await callProvider(async () => "good", ok, options())).toEqual({ ok: true, value: "good" });
  });

  it("retries temporary errors at most twice, with backoff and Retry-After", async () => {
    quiet();
    const sleeps: number[] = [];
    let calls = 0;
    const result = await callProvider(
      async () => {
        calls++;
        throw calls === 1 ? new ProviderError("busy", "rate_limited", 5_000) : new ProviderError("down", "server");
      },
      ok,
      options(sleeps)
    );
    expect(calls).toBe(3);
    expect(result).toEqual({ ok: false, reason: DESIGNER_MESSAGES.busyOther });
    expect(sleeps[0]).toBeGreaterThanOrEqual(5_000); // Retry-After honoured
    expect(sleeps[1]).toBeGreaterThanOrEqual(2_000);
  });

  it("does not retry a rejection (e.g. a bad request or auth failure)", async () => {
    quiet();
    let calls = 0;
    const result = await callProvider(
      async () => {
        calls++;
        throw new ProviderError("Not allowed.", "auth");
      },
      ok,
      options()
    );
    expect(calls).toBe(1);
    expect(result).toEqual({ ok: false, reason: DESIGNER_MESSAGES.setup });
  });

  it("a timeout is a temporary error", async () => {
    quiet();
    let calls = 0;
    const result = await callProvider(
      (signal) =>
        new Promise((_, reject) => {
          calls++;
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      ok,
      options()
    );
    expect(calls).toBe(3);
    expect(result).toEqual({ ok: false, reason: DESIGNER_MESSAGES.timedOut });
  });

  it("local models: a timeout is NOT retried (a slow model would just run twice)", async () => {
    quiet();
    let calls = 0;
    const result = await callProvider(
      (signal) =>
        new Promise((_, reject) => {
          calls++;
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      ok,
      { ...options(), retryTimeouts: false, retries: 1 }
    );
    expect(calls).toBe(1);
    expect(result).toEqual({ ok: false, reason: DESIGNER_MESSAGES.timedOut });
  });

  it("an invalid response gets exactly one more try", async () => {
    quiet();
    let calls = 0;
    const bad = await callProvider(async () => (calls++, "nonsense"), ok, options());
    expect(calls).toBe(2);
    expect(bad).toEqual({ ok: false, reason: DESIGNER_MESSAGES.unreadable });
    let second = 0;
    expect(await callProvider(async () => (second++ ? "good" : "nonsense"), ok, options())).toEqual({ ok: true, value: "good" });
  });

  it("designers see plain messages; the technical detail goes to the server log only", async () => {
    quiet();
    const fail = (error: ProviderError, provider?: "gemini" | "mock") =>
      callProvider(async () => { throw error; }, ok, { ...options(), retries: 0, provider });
    // The exact messages agreed for designers.
    expect(DESIGNER_MESSAGES).toMatchObject({
      busy: "Gemini is busy — try again in a few minutes.",
      unreadable: "The AI's answer couldn't be read — try again.",
      setup: "Analysis isn't set up correctly — tell your admin.",
      timedOut: "The analysis took too long and was stopped.",
    });
    const technical = [
      [new ProviderError("The Gemini design check had a temporary problem (HTTP 503: This model is currently experiencing high demand.).", "server"), DESIGNER_MESSAGES.busy],
      [new ProviderError("The Gemini design check is busy or the free-tier limit was reached (HTTP 429: Resource has been exhausted (e.g. check quota).).", "rate_limited", 1), DESIGNER_MESSAGES.busy],
      [new ProviderError("The Gemini design check refused this server's API key.", "auth"), DESIGNER_MESSAGES.setup],
      [new ProviderError("The Gemini design check rejected the request (HTTP 400: Request contains an invalid argument.).", "rejected"), DESIGNER_MESSAGES.setup],
      [new ProviderError("The Gemini design check returned an unreadable response.", "invalid_response"), DESIGNER_MESSAGES.unreadable],
      [new ProviderError("The Gemini design check couldn't be reached.", "network"), DESIGNER_MESSAGES.unreachable],
    ] as const;
    for (const [error, shown] of technical) {
      const result = await fail(error, "gemini");
      expect(result).toEqual({ ok: false, reason: shown });
      expect(JSON.stringify(result)).not.toMatch(/HTTP|Gemini design check|Resource has been exhausted|invalid argument|API key/);
    }
    // A malformed answer: no validator path shown.
    const malformed = await callProvider(async () => "nonsense", (): Validated<string> => ({ ok: false, reason: "unexpected response shape at texts.0.box_2d.0: too_small" }), { ...options(), provider: "gemini" });
    expect(malformed).toEqual({ ok: false, reason: DESIGNER_MESSAGES.unreadable });
    expect(JSON.stringify(malformed)).not.toContain("box_2d");
    // …but every technical detail is in the server log.
    const log = logged().join(" | ");
    expect(log).toContain("HTTP 503: This model is currently experiencing high demand.");
    expect(log).toContain("HTTP 400: Request contains an invalid argument.");
    expect(log).toContain("unexpected response shape at texts.0.box_2d.0: too_small");
    expect(log).toContain("(gemini, server)");
    // "Gemini is busy" only for the Gemini provider; other providers get a neutral wording.
    expect(designerMessage("server", "mock")).toBe(DESIGNER_MESSAGES.busyOther);
    expect(designerMessage("rate_limited", "gemini")).toBe(DESIGNER_MESSAGES.busy);
  });

  it("a stopped run stops the call", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(callProvider(async () => "good", ok, { timeoutMs: 50, runSignal: controller.signal })).rejects.toBeInstanceOf(RunAborted);
  });

  it("inPool never runs more than the limit at once", async () => {
    let active = 0;
    let peak = 0;
    await inPool([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBe(3);
  });
});
