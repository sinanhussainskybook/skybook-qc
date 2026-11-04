/**
 * Light / dark mode. Dark (the blue abstract theme) is the default; the switch in the navigation
 * (ThemeToggle) sets data-theme="light" or "dark" on <html> and remembers the choice in this browser.
 * Before anyone chooses, the device's own light/dark setting decides. Visual only: nothing is sent
 * to the server.
 */

export type Theme = "light" | "dark";

/** Where this browser remembers the choice. */
export const THEME_STORAGE_KEY = "skybook-qc-theme";

/**
 * Runs in <head> before the page is drawn (layout.tsx), so the page never flashes in the other
 * theme: the remembered choice, else the device's setting, else dark.
 */
export const THEME_INIT_SCRIPT = `(function(){var t="dark";try{var s=localStorage.getItem("${THEME_STORAGE_KEY}");t=s==="light"||s==="dark"?s:matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}catch(e){}document.documentElement.dataset.theme=t})()`;

/** The theme the page shows now. */
export function currentTheme(root: HTMLElement = document.documentElement): Theme {
  return root.dataset.theme === "light" ? "light" : "dark";
}

/** Shows `theme` and remembers it in this browser (when storage is allowed). */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage blocked (private window, settings): the choice lasts until the page is left.
  }
}
