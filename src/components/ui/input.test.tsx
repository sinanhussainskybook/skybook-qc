import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Input } from "@/components/ui/input";

/** Every text field: its direction comes from the first letter typed, so Arabic shows right to left. */
describe("Input", () => {
  it("is dir=auto by default", () => {
    expect(renderToStaticMarkup(<Input name="company" />)).toContain('dir="auto"');
  });

  it("keeps a direction the caller sets", () => {
    const html = renderToStaticMarkup(<Input name="code" dir="ltr" />);
    expect(html).toContain('dir="ltr"');
    expect(html).not.toContain('dir="auto"');
  });
});
