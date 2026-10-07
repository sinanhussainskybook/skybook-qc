import type { Database } from "@/lib/db/database";
import { addCompanyMember, findCompaniesByIdOrName } from "@/lib/db/companies";
import { findUserByEmail } from "@/lib/db/users";
import { checkEmail } from "@/lib/auth/user-input";

/**
 * Gives a user access to a company (D13) — used by `npm run company:grant`.
 * There is no admin screen for this (D2).
 */

export type GrantResult =
  | { ok: true; companyName: string; userName: string; alreadyMember: boolean }
  | { ok: false; error: string };

export async function grantCompanyAccess(
  db: Database,
  input: { company: string; email: string }
): Promise<GrantResult> {
  const email = checkEmail(input.email);
  if (!email.ok) return { ok: false, error: email.error };

  const reference = input.company.trim();
  if (!reference) return { ok: false, error: "Enter the company name or ID." };

  const companies = await findCompaniesByIdOrName(db, reference);
  if (companies.length === 0) {
    return { ok: false, error: `No company called or with the ID "${reference}".` };
  }
  if (companies.length > 1) {
    return {
      ok: false,
      error: `More than one company is called "${reference}". Use the ID instead:\n${companies
        .map((c) => `  ${c.id}  ${c.name}`)
        .join("\n")}`,
    };
  }

  const user = await findUserByEmail(db, email.value);
  if (!user) return { ok: false, error: `No user with the email ${email.value}.` };
  if (!user.active) return { ok: false, error: `${email.value} is switched off.` };

  const [company] = companies;
  const added = await addCompanyMember(db, company.id, user.id);
  return { ok: true, companyName: company.name, userName: user.name, alreadyMember: !added };
}
