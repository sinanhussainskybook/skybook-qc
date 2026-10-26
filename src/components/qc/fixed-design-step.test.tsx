// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FILES_BOX_ID, FixedDesignStep } from "@/components/qc/fixed-design-step";

/** After issues: how to check a fixed design, and a button that opens the folded upload section. */
afterEach(cleanup);

describe("Check a fixed design", () => {
  it("explains the next step, and the button opens the files box at the design step", () => {
    const scrolled = vi.fn();
    render(
      <>
        <details id={FILES_BOX_ID}>
          <summary>Files and Check Design</summary>
          <section id="content">Upload design</section>
        </details>
        <FixedDesignStep />
      </>
    );
    const box = document.getElementById(FILES_BOX_ID) as HTMLDetailsElement;
    document.getElementById("content")!.scrollIntoView = scrolled;
    expect(box.open).toBe(false);
    expect(screen.getByText(/fix these in your design file, then replace the design with the fixed one and press Check Design/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check a fixed design" }));
    expect(box.open).toBe(true);
    expect(scrolled).toHaveBeenCalledOnce();
  });
});
