import "server-only";
import type { Database } from "@/lib/db/database";
import { deleteCompanyRow, hasActiveAnalysis, listCompanySessionIds } from "@/lib/db/companies";
import { getCompanyLogo } from "@/lib/db/company-logos";
import type { LogoStorage } from "@/lib/storage/logo-storage";
import type { QcStorage } from "@/lib/storage/qc-storage";
import { removeSessionCompletely } from "@/lib/qc/session";
import { isUuid } from "@/lib/company/validation";

/**
 * Deletes a company for good — administrators only, after typing its name.
 *
 * Files are removed from Storage BEFORE the database rows, so nothing is
 * left behind unreferenced: first every temporary QC session of the company
 * (with its files), then the logo file, then the company row (members,
 * contact, brand guidelines, Golden Rules and the logo record go with it).
 * If Storage can't be reached, the company is kept and no file is left
 * without its record.
 *
 * The final delete only goes ahead if nothing new appeared meanwhile — no QC
 * session started and the logo not replaced (deleteCompanyRow checks both in
 * the same statement) — so a file added during the deletion is never left
 * behind. Refused while the worker is analysing a design for this company; a
 * run queued after that check is cancelled the way "Start over" cancels one
 * (its session is gone, the worker marks the run lost).
 */

export type DeleteCompanyResult = { ok: true; name: string } | { ok: false; error: string };

export const DELETE_COMPANY_MESSAGES = {
  notAllowed: "Only an administrator can delete a company.",
  notFound: "This company no longer exists. Reload the page.",
  confirm: "Type the company name exactly to confirm.",
  busy: "A design for this company is being analysed right now. Try again in a few minutes.",
  storage: "The company's files couldn't be removed, so the company was kept. Please try again.",
  changed: "Someone started a QC check or changed the logo while deleting, so the company was kept. Please try again.",
} as const;

export async function deleteCompany(
  db: Database,
  actor: { role: string; active: boolean } | null,
  input: { companyId: string; confirmName: string },
  storage: { logos: LogoStorage | null; qc: QcStorage | null }
): Promise<DeleteCompanyResult> {
  const M = DELETE_COMPANY_MESSAGES;
  if (!actor || !actor.active || actor.role !== "admin") return { ok: false, error: M.notAllowed };
  if (!isUuid(input.companyId)) return { ok: false, error: M.notFound };

  const [company] = await db.query<{ id: string; name: string }>("select id, name from companies where id = $1", [input.companyId]);
  if (!company) return { ok: false, error: M.notFound };
  if (input.confirmName.trim() !== company.name.trim()) return { ok: false, error: M.confirm };
  if (await hasActiveAnalysis(db, company.id)) return { ok: false, error: M.busy };

  // 1. Temporary QC sessions and their files (the same clean-up as Start over / expiry).
  for (const sessionId of await listCompanySessionIds(db, company.id)) {
    if (!(await removeSessionCompletely(db, storage.qc, sessionId))) return { ok: false, error: M.storage };
  }

  // 2. The logo file.
  const logo = await getCompanyLogo(db, company.id);
  if (logo) {
    if (!storage.logos) return { ok: false, error: M.storage };
    try {
      await storage.logos.remove(logo.storage_path);
    } catch (error) {
      console.error("Deleting a company: the logo file couldn't be removed; company kept:", error);
      return { ok: false, error: M.storage };
    }
  }

  // 3. The company and everything saved for it — unless something new appeared meanwhile.
  if (!(await deleteCompanyRow(db, company.id, logo?.storage_path ?? null))) {
    const [still] = await db.query("select 1 from companies where id = $1", [company.id]);
    // Its logo file is already gone: drop that record too (only if it's still the same logo), so the
    // kept company shows "no logo" rather than a broken image.
    if (still && logo) {
      await db.query("delete from company_logos where company_id = $1 and storage_path = $2", [company.id, logo.storage_path]);
    }
    return { ok: false, error: still ? M.changed : M.notFound };
  }
  return { ok: true, name: company.name };
}
