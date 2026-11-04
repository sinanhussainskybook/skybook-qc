"use client";

import { Moon, Sun } from "lucide-react";
import { applyTheme, currentTheme } from "@/lib/theme";

/**
 * The light / dark switch in the navigation pill: a sun in dark mode, a moon in light mode (which icon
 * shows is decided by CSS from data-theme, so the server and the browser draw the same button).
 */
export function ThemeToggle() {
  return (
    <button
      type="button"
      onClick={() => applyTheme(currentTheme() === "light" ? "dark" : "light")}
      aria-label="Switch between light and dark mode"
      title="Switch between light and dark mode"
      className="theme-nav-item flex size-9 shrink-0 items-center justify-center rounded-full text-white/75 transition-colors outline-none hover:bg-white/10 hover:text-white focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Sun className="theme-icon-sun size-4" aria-hidden />
      <Moon className="theme-icon-moon size-4" aria-hidden />
    </button>
  );
}
