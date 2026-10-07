import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Secrets kept OUTSIDE the project folder.
 *
 * The project lives in a synced folder (OneDrive), so its secrets file
 * lives at `<home>/.skybook-qc/.env.local` instead, which is not synced.
 * next.config.ts and the command-line scripts load it with Node's own
 * env-file reader.
 *
 * - A value that is already set (e.g. from a project .env.local, which
 *   Next.js reads first) is never overwritten.
 * - Values are only loaded, never printed. A missing file is skipped.
 * - Nothing here starts with NEXT_PUBLIC_, so nothing reaches the browser.
 */

export function externalEnvFile(home: string = homedir()): string {
  return path.join(home, ".skybook-qc", ".env.local");
}

/** Loads the outside secrets file if it exists. Returns whether it was found. */
export function loadExternalEnv(file: string = externalEnvFile()): boolean {
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}
