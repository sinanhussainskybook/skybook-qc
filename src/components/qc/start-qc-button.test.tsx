// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * "Start a QC check" on the company page starts the check and opens it — one click, no extra screen —
 * unless the last check is complete: then it asks before that check's files are deleted.
 */

const state = vi.hoisted(() => ({ push: vi.fn(), start: vi.fn(), startNew: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/qc/actions", () => ({ startSessionAction: state.start, startNewCheckAction: state.startNew }));

const { StartQcButton } = await import("@/components/qc/start-qc-button");

beforeEach(() => {
  state.push.mockReset();
  state.start.mockReset();
  state.startNew.mockReset();
});
afterEach(cleanup);

const clickStart = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Start a QC check/ }));
  });
};
const FINISHED = /Your last QC check for this company is finished/;

describe("Start a QC check", () => {
  it("starts a Design / Poster check for this company, then opens it", async () => {
    state.start.mockResolvedValue({ ok: true });
    render(<StartQcButton companyId="c1" />);
    await clickStart();
    const sent = state.start.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(sent)).toEqual({ companyId: "c1", contentType: "design_poster" });
    expect(state.push).toHaveBeenCalledWith("/companies/c1/qc/new");
    expect(state.startNew).not.toHaveBeenCalled();
  });

  it("stays put and says why when the check can't be started", async () => {
    state.start.mockResolvedValue({ error: "This company isn't available. Reload the page and try again." });
    render(<StartQcButton companyId="c1" />);
    await clickStart();
    expect(state.push).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/isn't available/);
  });

  describe("the last check is complete", () => {
    beforeEach(() => state.start.mockResolvedValue({ confirmNewCheck: { sessionId: "s1" } }));

    it("asks first — nothing is deleted or opened yet", async () => {
      render(<StartQcButton companyId="c1" />);
      await clickStart();
      expect(screen.getByText(FINISHED)).toBeTruthy();
      expect(state.startNew).not.toHaveBeenCalled();
      expect(state.push).not.toHaveBeenCalled();
    });

    it("Cancel goes back to the Start button and deletes nothing", async () => {
      render(<StartQcButton companyId="c1" />);
      await clickStart();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByText(FINISHED)).toBeNull();
      expect(screen.getByRole("button", { name: /Start a QC check/ })).toBeTruthy();
      expect(state.startNew).not.toHaveBeenCalled();
    });

    it("confirmed: sends this company and that completed check, then opens the fresh one", async () => {
      state.startNew.mockResolvedValue({ ok: true });
      render(<StartQcButton companyId="c1" />);
      await clickStart();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Start a new check/ }));
      });
      expect(Object.fromEntries(state.startNew.mock.calls[0][1] as FormData)).toEqual({ companyId: "c1", sessionId: "s1", contentType: "design_poster" });
      expect(state.push).toHaveBeenCalledWith("/companies/c1/qc/new");
    });

    it("if the files can't be removed, stays on the page and says why", async () => {
      state.startNew.mockResolvedValue({ error: "The session couldn't be cleared right now. Please try again in a moment." });
      render(<StartQcButton companyId="c1" />);
      await clickStart();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Start a new check/ }));
      });
      expect(state.push).not.toHaveBeenCalled();
      expect(screen.getByRole("alert").textContent).toMatch(/couldn't be cleared/);
    });
  });
});
