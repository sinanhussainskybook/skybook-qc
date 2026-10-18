import "server-only";
import { randomUUID } from "node:crypto";
import type { Database } from "@/lib/db/database";
import { deleteCompanyLogo, listCompanyLogoPaths, upsertCompanyLogo, type CompanyLogo } from "@/lib/db/company-logos";
import type { CheckedLogo } from "@/lib/company/logo-file";
import { LOGO_LINK_SECONDS, type LogoStorage } from "@/lib/storage/logo-storage";

/**
 * Upload, replace, remove and show a company's one logo (D3).
 *
 * `companyId` must come from the access check (requireCompanyAccess /
 * findCompanyForUser), never straight from the browser. The storage path
 * is made here from it — the browser can't choose where a file goes.
 *
 * Order of work, so the page never points at a missing file:
 *   save:   upload new file → save metadata → delete old file
 *           (metadata fails → delete the new file again)
 *   remove: delete metadata → delete file
 * A failed delete of an old / removed file is logged; the file is private
 * and no longer referenced, so it can be cleaned up by hand.
 */

export type LogoResult =
  | { ok: true; cleanupFailed?: boolean }
  | { ok: false; reason: "storage" | "database" | "no-logo" };

export function logoStoragePath(companyId: string, ext: string): string {
  return `${companyId}/${randomUUID()}.${ext}`;
}

export async function saveCompanyLogo(
  db: Database,
  storage: LogoStorage,
  companyId: string,
  logo: CheckedLogo
): Promise<LogoResult> {
  const path = logoStoragePath(companyId, logo.ext);

  try {
    await storage.upload(path, logo.bytes, logo.mime);
  } catch (error) {
    console.error("Logo upload to Storage failed:", error);
    return { ok: false, reason: "storage" };
  }

  let previousPath: string | null;
  try {
    ({ previousPath } = await upsertCompanyLogo(db, companyId, {
      fileName: logo.fileName,
      storagePath: path,
      mimeType: logo.mime,
      fileSize: logo.size,
    }));
  } catch (error) {
    console.error("Saving logo metadata failed:", error);
    // Don't leave the new file behind with nothing pointing at it.
    await removeQuietly(storage, path, "new logo after a failed save");
    return { ok: false, reason: "database" };
  }

  if (previousPath && previousPath !== path) {
    const removed = await removeQuietly(storage, previousPath, "replaced logo");
    if (!removed) return { ok: true, cleanupFailed: true };
  }
  return { ok: true };
}

export async function removeCompanyLogo(
  db: Database,
  storage: LogoStorage,
  companyId: string
): Promise<LogoResult> {
  let path: string | null;
  try {
    path = await deleteCompanyLogo(db, companyId);
  } catch (error) {
    console.error("Removing logo metadata failed:", error);
    return { ok: false, reason: "database" };
  }
  if (!path) return { ok: false, reason: "no-logo" };

  const removed = await removeQuietly(storage, path, "removed logo");
  return removed ? { ok: true } : { ok: true, cleanupFailed: true };
}

/** A short-lived link to show the logo, or null if there's no logo or Storage doesn't answer. */
export async function logoImageUrl(
  storage: LogoStorage | null,
  logo: Pick<CompanyLogo, "storage_path"> | null
): Promise<string | null> {
  if (!logo || !storage) return null;
  try {
    return await storage.signedUrl(logo.storage_path, LOGO_LINK_SECONDS);
  } catch (error) {
    console.error("Making a logo link failed:", error);
    return null;
  }
}

/** How long the home page waits for its card logos before showing initial letters instead. */
export const CARD_LOGOS_TIMEOUT_MS = 2_000;

/**
 * Links to show the logos of these companies (the home page cards), by company ID. A company with no
 * logo, or whose link couldn't be made in time, is left out — its card shows the initial letter instead.
 * `companyIds` must be companies the user may open (from listCompaniesForUser).
 *
 * The whole lookup has a short deadline of its own (not Storage's 20-second request timeout), so a slow
 * Storage never holds up the company list: links made by then are used, the rest are left out. A link
 * that arrives late is simply ignored; its failure is still logged by logoImageUrl.
 */
export async function companyLogoUrls(
  db: Database,
  storage: LogoStorage | null,
  companyIds: string[],
  timeoutMs: number = CARD_LOGOS_TIMEOUT_MS
): Promise<Record<string, string>> {
  if (!storage || companyIds.length === 0) return {};
  const urls: Record<string, string> = {};

  const lookup = (async () => {
    let paths: Map<string, string>;
    try {
      paths = await listCompanyLogoPaths(db, companyIds);
    } catch (error) {
      console.error("Reading company logos failed:", error);
      return;
    }
    await Promise.all(
      [...paths].map(async ([companyId, storage_path]) => {
        const url = await logoImageUrl(storage, { storage_path });
        if (url) urls[companyId] = url;
      })
    );
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), timeoutMs);
  });
  try {
    if ((await Promise.race([lookup, deadline])) === "late") {
      console.error(`Company card logos took longer than ${timeoutMs} ms; showing initials for the rest.`);
    }
  } finally {
    clearTimeout(timer);
  }
  // A copy: links that arrive after the deadline must not change what the page already has.
  return { ...urls };
}

async function removeQuietly(storage: LogoStorage, path: string, what: string): Promise<boolean> {
  try {
    await storage.remove(path);
    return true;
  } catch (error) {
    console.error(`Could not delete the ${what} from Storage (${path}). Remove it by hand:`, error);
    return false;
  }
}
