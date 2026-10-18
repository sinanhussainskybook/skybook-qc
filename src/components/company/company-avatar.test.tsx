// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { CompanyAvatar } from "@/components/company/company-avatar";

/** A home page card's badge: the saved logo, or the initial letter when there's none or it doesn't load. */

afterEach(cleanup);

describe("CompanyAvatar", () => {
  it("shows the company's logo when it has one", () => {
    const { container } = render(<CompanyAvatar name="Acme" logoUrl="https://storage.test/sign/acme.png" />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://storage.test/sign/acme.png");
    expect(container.textContent).toBe("");
  });

  it("shows the initial letter when there is no logo", () => {
    const { container } = render(<CompanyAvatar name="globex" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("g");
  });

  it("falls back to the initial letter when the logo fails to load", async () => {
    const { container } = render(<CompanyAvatar name="Acme" logoUrl="https://storage.test/sign/expired.png" />);
    await act(async () => {
      fireEvent.error(container.querySelector("img")!);
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });
});
