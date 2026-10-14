// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/** The company page while a QC check is in progress: Continue it, or Start a new check (after confirming). */

const state = vi.hoisted(() => ({ push: vi.fn(), startNew: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/qc/actions", () => ({ startNewCheckAction: state.startNew }));

const { ContinueQc } = await import("@/components/qc/continue-qc");

beforeEach(() => {
  state.push.mockReset();
  state.startNew.mockReset();
});
afterEach(cleanup);

const renderIt = () => render(<ContinueQc companyId="c1" sessionId="s1" hoursLeft={5} />);

describe("Continue QC check / Start a new check", () => {
  it("Continue is a plain link to the check in progress — nothing is sent or changed", () => {
    renderIt();
    const link = screen.getByRole("link", { name: /Continue QC check/ });
    expect(link.getAttribute("href")).toBe("/companies/c1/qc/new");
    fireEvent.click(link);
    expect(state.startNew).not.toHaveBeenCalled();
    expect(screen.getByText(/5 hours left/)).toBeTruthy();
  });

  it("Start a new check asks first; Cancel changes nothing", () => {
    renderIt();
    fireEvent.click(screen.getByRole("button", { name: /Start a new check/ }));
    expect(screen.getByText("Delete this check's brief and design?")).toBeTruthy();
    expect(state.startNew).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Delete this check's brief and design?")).toBeNull();
    expect(state.startNew).not.toHaveBeenCalled();
  });

  it("confirmed: sends this company and this session, then opens the fresh check", async () => {
    state.startNew.mockResolvedValue({ ok: true });
    renderIt();
    fireEvent.click(screen.getByRole("button", { name: /Start a new check/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start a new check" }));
    });
    const sent = state.startNew.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(sent)).toEqual({ companyId: "c1", sessionId: "s1", contentType: "design_poster" });
    expect(state.push).toHaveBeenCalledWith("/companies/c1/qc/new");
  });

  it("if it can't be done, stays on the page and says why", async () => {
    state.startNew.mockResolvedValue({ error: "The session couldn't be cleared right now. Please try again in a moment." });
    renderIt();
    fireEvent.click(screen.getByRole("button", { name: /Start a new check/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start a new check" }));
    });
    expect(state.push).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/couldn't be cleared/);
  });
});
