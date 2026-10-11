// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

/**
 * Regression (2026-10-10): the panel said "Design checked — the result is
 * below" while the page below still showed "The result appears when the
 * analysis finishes" — for the few seconds the server takes to rebuild the
 * page after the run ends. The refresh now runs as a transition, and until it
 * lands the panel says the result is being prepared.
 */

const state = vi.hoisted(() => ({ pending: null as boolean | null, refresh: vi.fn(), startTransition: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    // null → React's own; true / false → forced, to show each state.
    useTransition: () => {
      const real = react.useTransition();
      if (state.pending === null) {
        return [real[0], (fn: () => void) => { state.startTransition(); real[1](fn); }] as const;
      }
      return [state.pending, (fn: () => void) => { state.startTransition(); fn(); }] as const;
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: state.refresh }) }));
const actions = vi.hoisted(() => ({ analysisStatusAction: vi.fn(), startAnalysisAction: vi.fn(async () => ({})) }));
vi.mock("@/lib/qc/actions", () => actions);

const { AnalysisPanel } = await import("@/components/qc/analysis-panel");

const view = (status: string) => ({ id: "r1", kind: "content" as const, status: status as "done", stage: null, done: 1, total: 2, reason: null, mock: false, provider: "gemini" as const });
const panel = (status: string) => (
  <AnalysisPanel sessionId="s1" configured hasContent stale={false} runsLeft={4} initial={view(status)} />
);

beforeEach(() => {
  state.pending = null;
  state.refresh.mockReset();
  state.startTransition.mockReset();
  actions.analysisStatusAction.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("design check status", () => {
  it("while the finished result is still being loaded: 'Preparing the result…', not 'Design checked'", () => {
    state.pending = true;
    render(panel("done"));
    expect(screen.getByRole("status").textContent).toBe("Preparing the result…");
    expect(screen.queryByText(/Design checked/)).toBeNull();
  });

  it("once the result has loaded: 'Design checked — the result is below.'", () => {
    state.pending = false;
    render(panel("done"));
    expect(screen.getByText("Design checked — the result is below.")).toBeTruthy();
    expect(screen.queryByText(/Preparing the result/)).toBeNull();
  });

  it("when the run finishes, the page is refreshed once, as a transition (so its loading is tracked)", async () => {
    vi.useFakeTimers();
    actions.analysisStatusAction.mockResolvedValue(view("done"));
    render(panel("processing"));
    expect(screen.getByText("Checking the design…")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_600);
    });
    expect(actions.analysisStatusAction).toHaveBeenCalledWith("s1", "content");
    expect(state.startTransition).toHaveBeenCalledTimes(1);
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
});
