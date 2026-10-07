import "server-only";
import { randomUUID } from "node:crypto";
import type { Database } from "@/lib/db/database";
import { deleteCompanyLogo, upsertCompanyLogo, type CompanyLogo } from "@/lib/db/company-logos";
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

async function removeQuietly(storage: LogoStorage, path: string, what: string): Promise<boolean> {
  try {
    await storage.remove(path);
    return true;
  } catch (error) {
    console.error(`Could not delete the ${what} from Storage (${path}). Remove it by hand:`, error);
    return false;
  }
}
