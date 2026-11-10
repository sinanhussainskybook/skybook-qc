// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/** Stage 2 safeguard: a brief reading stopped because a file is too long for Local AI. */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/qc/actions", () => ({ analysisStatusAction: vi.fn(), startAnalysisAction: vi.fn(async () => ({})) }));
const { AnalysisPanel } = await import("@/components/qc/analysis-panel");
const { oversizedBriefMessage } = await import("@/lib/qc/brief-length");
const { BRIEF_UNCLEAR_MESSAGE } = await import("@/lib/qc/requirements");

const TOO_LONG = oversizedBriefMessage([{ name: "brief.pdf", chars: 15_230 }], 12_000);
const failed = (reason: string) => ({ id: "r1", kind: "information" as const, status: "failed" as const, stage: null, done: 1, total: 2, reason, mock: false, provider: "local" as const });
const panel = (reason: string, stale = false) => (
  <AnalysisPanel kind="information" sessionId="s1" configured hasContent stale={stale} found={0} initial={failed(reason)} />
);

afterEach(cleanup);

describe("brief too long for Local AI", () => {
  it("shows its own message (the file, the limit, what to do) — not 'unclear brief' — and no Try again", () => {
    render(panel(TOO_LONG));
    expect(screen.getByRole("alert").textContent).toBe(TOO_LONG);
    expect(screen.queryByText(new RegExp(BRIEF_UNCLEAR_MESSAGE.slice(0, 20)))).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("once the brief files have changed (the long one removed): says so, with Read again", () => {
    render(panel(TOO_LONG, true));
    expect(screen.getByRole("alert").textContent).toBe("A brief was added or removed since it was read — read it again to include it.");
    expect(screen.getByRole("button", { name: /Read again/ })).toBeTruthy();
  });

  it("brief files changed while being read: its own message (read the updated brief again), with Try again", async () => {
    const { BRIEF_FILES_CHANGED_MESSAGE } = await import("@/lib/qc/brief-length");
    render(<AnalysisPanel kind="information" sessionId="s1" configured hasContent stale={false} found={0} initial={{ ...failed(BRIEF_FILES_CHANGED_MESSAGE), status: "cancelled" as "failed" }} />);
    expect(screen.getByRole("alert").textContent).toBe("The brief files changed while they were being read — read the updated brief again.");
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
  });

  it("any other failed reading: unchanged", () => {
    render(panel("brief.docx: the Word file couldn't be read"));
    expect(screen.getByRole("alert").textContent).toBe(`${BRIEF_UNCLEAR_MESSAGE} (brief.docx: the Word file couldn't be read)`);
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
  });
});
