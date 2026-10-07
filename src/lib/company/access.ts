import "server-only";
import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/db/client";
import { findAccessibleCompany, listCompaniesForUser } from "@/lib/db/companies";
import type { User } from "@/lib/db/users";
import { requireUser } from "@/lib/auth/current-user";
import { isUuid } from "@/lib/company/validation";
import type { Company, CompanySummary } from "@/lib/company/types";

/**
 * Who may open which company (D13), checked on the server for every page
 * and every action. A company the user may not open looks exactly like one
 * that doesn't exist.
 */

/** The signed-in user and the companies they may open. */
export async function getCompaniesForCurrentUser(): Promise<{
  user: User;
  companies: CompanySummary[];
}> {
  const user = await requireUser();
  return { user, companies: await listCompaniesForUser(getDatabase(), user) };
}

/** The company, or null if it doesn't exist or `user` may not open it. */
export async function findCompanyForUser(
  user: User,
  companyId: unknown
): Promise<Company | null> {
  if (!isUuid(companyId)) return null;
  return findAccessibleCompany(getDatabase(), user, companyId);
}

/**
 * For pages: the signed-in user and the company. Signed out → sign-in page;
 * no access or no such company → "not found".
 */
export async function requireCompanyAccess(
  companyId: unknown
): Promise<{ user: User; company: Company }> {
  const user = await requireUser();
  const company = await findCompanyForUser(user, companyId);
  if (!company) notFound();
  return { user, company };
}
