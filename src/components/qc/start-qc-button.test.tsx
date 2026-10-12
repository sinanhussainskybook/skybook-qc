// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/** "Start a QC check" on the company page starts the check and opens it — one click, no extra screen. */

const state = vi.hoisted(() => ({ push: vi.fn(), start: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/qc/actions", () => ({ startSessionAction: state.start }));

const { StartQcButton } = await import("@/components/qc/start-qc-button");

beforeEach(() => {
  state.push.mockReset();
  state.start.mockReset();
});
afterEach(cleanup);

describe("Start a QC check", () => {
  it("starts a Design / Poster check for this company, then opens it", async () => {
    state.start.mockResolvedValue({ ok: true });
    render(<StartQcButton companyId="c1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start a QC check/ }));
    });
    const sent = state.start.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(sent)).toEqual({ companyId: "c1", contentType: "design_poster" });
    expect(state.push).toHaveBeenCalledWith("/companies/c1/qc/new");
  });

  it("stays put and says why when the check can't be started", async () => {
    state.start.mockResolvedValue({ error: "This company isn't available. Reload the page and try again." });
    render(<StartQcButton companyId="c1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start a QC check/ }));
    });
    expect(state.push).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/isn't available/);
  });
});
