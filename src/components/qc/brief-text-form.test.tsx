// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/** Enter brief text: the box next to Upload brief — checks in the browser, then the server's answer. */

const actions = vi.hoisted(() => ({ saveBriefTextAction: vi.fn() }));
vi.mock("@/lib/qc/actions", () => actions);
const { BriefTextForm } = await import("@/components/qc/brief-text-form");
const { BRIEF_TEXT_MESSAGES } = await import("@/lib/qc/brief-text");

const SESSION = "5b6d0f0e-8c1a-4a57-9a4e-2a6f1d6c9e02";

const open = () => fireEvent.click(screen.getByRole("button", { name: "Enter brief text" }));
const box = () => screen.getByLabelText("Brief text") as HTMLTextAreaElement;
async function save() {
  await act(async () => {
    fireEvent.submit(box().form!);
  });
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  actions.saveBriefTextAction.mockReset().mockResolvedValue({ ok: true, message: "Saved as Typed brief.txt — the brief is being read now." });
});
afterEach(cleanup);

describe("BriefTextForm", () => {
  it("opens a text box; Save sends the text with the session, then closes and says it was saved", async () => {
    render(<BriefTextForm sessionId={SESSION} disabled={false} full={false} />);
    open();
    fireEvent.change(box(), { target: { value: "Headline: Summer Sale" } });
    expect(screen.getByText("21 / 20,000 characters")).toBeTruthy();
    await save();
    expect(actions.saveBriefTextAction).toHaveBeenCalledTimes(1);
    const sent = actions.saveBriefTextAction.mock.calls[0][1] as FormData;
    expect(sent.get("sessionId")).toBe(SESSION);
    expect(sent.get("briefText")).toBe("Headline: Summer Sale");
    expect(screen.queryByLabelText("Brief text")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Saved as Typed brief.txt — the brief is being read now.");
  });

  it("empty: says so here, nothing is sent", async () => {
    render(<BriefTextForm sessionId={SESSION} disabled={false} full={false} />);
    open();
    fireEvent.change(box(), { target: { value: "   " } });
    await save();
    expect(actions.saveBriefTextAction).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(BRIEF_TEXT_MESSAGES.empty);
  });

  it("over the limit: the count turns red and Save is off", () => {
    render(<BriefTextForm sessionId={SESSION} disabled={false} full={false} />);
    open();
    fireEvent.change(box(), { target: { value: "x".repeat(20_001) } });
    expect(screen.getByText("20,001 / 20,000 characters").className).toContain("text-fail");
    expect((screen.getByRole("button", { name: "Save brief text" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the server refuses: its message is shown and the text is kept to fix", async () => {
    actions.saveBriefTextAction.mockResolvedValue({ error: "Files can't be uploaded right now. Please try again in a moment." });
    render(<BriefTextForm sessionId={SESSION} disabled={false} full={false} />);
    open();
    fireEvent.change(box(), { target: { value: "Headline: Sale" } });
    await save();
    expect(screen.getByRole("alert").textContent).toBe("Files can't be uploaded right now. Please try again in a moment.");
    expect(box().value).toBe("Headline: Sale");
  });

  it("a huge paste: the reason shows at once, Save is off and nothing is sent", async () => {
    render(<BriefTextForm sessionId={SESSION} disabled={false} full={false} />);
    open();
    fireEvent.change(box(), { target: { value: "x".repeat(2_000_000) } });
    expect(screen.getByRole("alert").textContent).toBe(BRIEF_TEXT_MESSAGES.tooLong(2_000_000));
    expect((screen.getByRole("button", { name: "Save brief text" }) as HTMLButtonElement).disabled).toBe(true);
    await save();
    expect(actions.saveBriefTextAction).not.toHaveBeenCalled();
  });

  it("Local AI's limit: the count shows 12,000 and longer text is refused with the reason", () => {
    render(<BriefTextForm sessionId={SESSION} disabled={false} full={false} maxChars={12_000} />);
    open();
    fireEvent.change(box(), { target: { value: "x".repeat(12_001) } });
    expect(screen.getByText("12,001 / 12,000 characters").className).toContain("text-fail");
    expect(screen.getByRole("alert").textContent).toBe(BRIEF_TEXT_MESSAGES.beyondReading(12_001, 12_000));
    expect((screen.getByRole("button", { name: "Save brief text" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box(), { target: { value: "x".repeat(12_000) } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the request itself fails: a clear message, not a vague one, and the text is kept", async () => {
    actions.saveBriefTextAction.mockRejectedValue(new Error("Body exceeded 1 MB limit"));
    render(<BriefTextForm sessionId={SESSION} disabled={false} full={false} />);
    open();
    fireEvent.change(box(), { target: { value: "Headline: Sale" } });
    await save();
    expect(screen.getByRole("alert").textContent).toBe(BRIEF_TEXT_MESSAGES.notSent);
    expect(box().value).toBe("Headline: Sale");
  });

  it("no storage, or the brief area is full: the button is off", () => {
    const { rerender } = render(<BriefTextForm sessionId={SESSION} disabled full={false} />);
    expect((screen.getByRole("button", { name: "Enter brief text" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<BriefTextForm sessionId={SESSION} disabled={false} full />);
    expect((screen.getByRole("button", { name: "Enter brief text" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("BriefTextForm — Arabic", () => {
  it("the brief text box takes its direction from what is typed (dir=auto)", () => {
    render(<BriefTextForm sessionId={SESSION} disabled={false} full={false} />);
    open();
    expect(box().getAttribute("dir")).toBe("auto");
  });
});
