// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Regression: a refused save must not wipe what the designer typed.
 * React resets a <form action={…}> after every action — even one the
 * server refused — so these forms submit by hand instead.
 */

const actions = vi.hoisted(() => ({
  saveRequirementAction: vi.fn(),
  setRequirementConfirmedAction: vi.fn(async () => ({})),
  deleteRequirementAction: vi.fn(async () => ({})),
  setPlatformAction: vi.fn(),
}));
vi.mock("@/lib/qc/actions", () => actions);

const { RequirementsEditor } = await import("@/components/qc/requirements-editor");
const { PlatformForm } = await import("@/components/qc/platform-form");

const SESSION = "5b6d0f0e-8c1a-4a57-9a4e-2a6f1d6c9e02";
const field = (id: string) => document.getElementById(id) as HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement;
const submit = async (form: HTMLElement) => {
  await act(async () => {
    fireEvent.submit(form);
  });
};

beforeEach(() => {
  actions.saveRequirementAction.mockReset();
  actions.setPlatformAction.mockReset();
});
afterEach(cleanup);

describe("Requirements form keeps what was typed", () => {
  function fillNew() {
    fireEvent.change(field("req-new-type"), { target: { value: "offer" } });
    fireEvent.change(field("req-new-label"), { target: { value: "Summer offer" } });
    fireEvent.change(field("req-new-value"), { target: { value: "20% off all villas" } });
    fireEvent.change(field("req-new-notes"), { target: { value: "Top right corner" } });
    fireEvent.click(screen.getByLabelText(/^Must have/)); // on → off
  }

  it("A. a refused new requirement shows the error and keeps every field", async () => {
    actions.saveRequirementAction.mockResolvedValue({ errors: { expected_value: "Too long." } });
    render(<RequirementsEditor sessionId={SESSION} requirements={[]} />);
    fillNew();
    await submit(screen.getByRole("form", { name: "Add requirement" }));

    expect(actions.saveRequirementAction).toHaveBeenCalledTimes(1);
    const sent = actions.saveRequirementAction.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(sent)).toMatchObject({
      sessionId: SESSION,
      type: "offer",
      label: "Summer offer",
      expected_value: "20% off all villas",
      notes: "Top right corner",
    });
    expect(sent.has("mandatory")).toBe(false);
    // No per-item confirm: Confirm & Run QC confirms the whole list.
    expect(sent.has("confirmed")).toBe(false);
    expect(screen.queryByLabelText(/^Confirmed/)).toBeNull();

    expect(screen.getByText("Too long.")).toBeTruthy();
    expect(field("req-new-type").value).toBe("offer");
    expect(field("req-new-label").value).toBe("Summer offer");
    expect(field("req-new-value").value).toBe("20% off all villas");
    expect(field("req-new-notes").value).toBe("Top right corner");
    expect((screen.getByLabelText(/^Must have/) as HTMLInputElement).checked).toBe(false);
  });

  it("a whole-form error (e.g. session gone) also keeps the fields", async () => {
    actions.saveRequirementAction.mockResolvedValue({ error: "This QC session isn't available any more. Reload the page." });
    render(<RequirementsEditor sessionId={SESSION} requirements={[]} />);
    fillNew();
    await submit(screen.getByRole("form", { name: "Add requirement" }));
    expect(screen.getByRole("alert").textContent).toMatch(/isn't available/);
    expect(field("req-new-value").value).toBe("20% off all villas");
  });

  it("B. a valid new requirement is saved and the form closes", async () => {
    actions.saveRequirementAction.mockResolvedValue({ ok: true });
    render(<RequirementsEditor sessionId={SESSION} requirements={[{ id: "r0", type: "cta", label: null, expected_value: "Book now", notes: null, mandatory: true, confirmed: true, source: "manual" }]} />);
    fireEvent.click(screen.getByRole("button", { name: /Add requirement/ }));
    fillNew();
    await submit(screen.getByRole("form", { name: "Add requirement" }));
    expect(actions.saveRequirementAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("form", { name: "Add requirement" })).toBeNull();
  });

  it("C. a refused edit keeps the edited values", async () => {
    actions.saveRequirementAction.mockResolvedValue({ errors: { type: "Choose a requirement type." } });
    const requirement = { id: "r1", type: "offer", label: "Old", expected_value: "10% off", notes: null, mandatory: true, confirmed: false, source: "manual" as const };
    render(<RequirementsEditor sessionId={SESSION} requirements={[requirement]} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    fireEvent.change(field("req-r1-label"), { target: { value: "New name" } });
    fireEvent.change(field("req-r1-value"), { target: { value: "25% off" } });
    fireEvent.change(field("req-r1-notes"), { target: { value: "Bold" } });
    fireEvent.click(screen.getByLabelText(/^Must have/));
    await submit(screen.getByRole("form", { name: "Edit requirement" }));

    const sent = actions.saveRequirementAction.mock.calls[0][1] as FormData;
    expect(sent.get("requirementId")).toBe("r1");
    expect(screen.getByText("Choose a requirement type.")).toBeTruthy();
    expect(field("req-r1-label").value).toBe("New name");
    expect(field("req-r1-value").value).toBe("25% off");
    expect(field("req-r1-notes").value).toBe("Bold");
    expect((screen.getByLabelText(/^Must have/) as HTMLInputElement).checked).toBe(false);
  });
});

describe("Platform form keeps what was typed (Round 1 fix)", () => {
  it("a refused Other size keeps platform, size and unit", async () => {
    actions.setPlatformAction.mockResolvedValue({ error: "Describe where the content will be used (up to 120 characters)." });
    render(
      <PlatformForm
        sessionId={SESSION}
        media="visual"
        current={{ platform: null, placement: null, customLabel: null, customWidth: null, customHeight: null, customUnit: null, customMinDpi: null, customMaxBytes: null }}
      />
    );
    fireEvent.change(field("qc-platform"), { target: { value: "other" } });
    fireEvent.change(field("qc-custom-width"), { target: { value: "1080" } });
    fireEvent.change(field("qc-custom-height"), { target: { value: "1350" } });
    fireEvent.change(field("qc-custom-unit"), { target: { value: "px" } });
    await submit(field("qc-platform").form!);
    expect(screen.getByRole("alert").textContent).toMatch(/Describe where/);
    expect(field("qc-platform").value).toBe("other");
    expect(field("qc-custom-width").value).toBe("1080");
    expect(field("qc-custom-height").value).toBe("1350");
    expect(field("qc-custom-unit").value).toBe("px");
  });
});
