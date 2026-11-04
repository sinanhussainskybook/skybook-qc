// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from "@/lib/theme";

/** Light / dark mode: the switch in the navigation, and the script that picks the theme before the first paint. */

const root = document.documentElement;
const runInitScript = () => new Function(THEME_INIT_SCRIPT)();
const deviceSetting = (light: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: light && query === "(prefers-color-scheme: light)" }));

beforeEach(() => {
  localStorage.clear();
  delete root.dataset.theme;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThemeToggle", () => {
  it("switches dark to light and back, and remembers the choice in this browser", () => {
    root.dataset.theme = "dark";
    const { getByRole } = render(<ThemeToggle />);
    const button = getByRole("button", { name: "Switch between light and dark mode" });
    fireEvent.click(button);
    expect(root.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    fireEvent.click(button);
    expect(root.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("has both icons; CSS shows the sun in dark mode and the moon in light mode", () => {
    const { container } = render(<ThemeToggle />);
    expect(container.querySelector(".theme-icon-sun")).not.toBeNull();
    expect(container.querySelector(".theme-icon-moon")).not.toBeNull();
  });
});

describe("THEME_INIT_SCRIPT", () => {
  it("uses the remembered choice", () => {
    deviceSetting(true);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    runInitScript();
    expect(root.dataset.theme).toBe("dark");
  });

  it("follows the device's setting until a choice is made", () => {
    deviceSetting(true);
    runInitScript();
    expect(root.dataset.theme).toBe("light");
    deviceSetting(false);
    runInitScript();
    expect(root.dataset.theme).toBe("dark");
  });

  it("ignores an unknown stored value, and falls back to dark when storage is blocked", () => {
    deviceSetting(false);
    localStorage.setItem(THEME_STORAGE_KEY, "purple");
    runInitScript();
    expect(root.dataset.theme).toBe("dark");
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    deviceSetting(true);
    runInitScript();
    expect(root.dataset.theme).toBe("dark");
  });
});
