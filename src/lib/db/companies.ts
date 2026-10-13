import type { Database } from "@/lib/db/database";
import type { Role } from "@/lib/auth/roles";
import type { Company, CompanySummary } from "@/lib/company/types";

/**
 * Companies and who may open them (D13).
 *
 * Admins may open every company. Everyone else only the companies they are
 * a member of. Every read here takes the user, so a caller can't forget
 * the check.
 */

type Viewer = { id: string; role: Role };

const COMPANY_COLUMNS =
  "c.id, c.name, c.description, c.category, c.country, c.city, c.address, c.active, c.created_at, c.updated_at";

/** SQL: true when the role parameter is admin, or the user parameter is a member of company c. */
function canAccess(roleParam: number, userParam: number) {
  return `($${roleParam}::text = 'admin' or exists (
    select 1 from company_members m where m.company_id = c.id and m.user_id = $${userParam}::uuid
  ))`;
}

/** Creates a company and makes its creator a member, in one statement. */
export async function insertCompany(
  db: Database,
  input: { name: string; createdBy: string }
): Promise<{ id: string; name: string }> {
  const [row] = await db.query<{ id: string; name: string }>(
    `with c as (
       insert into companies (name, created_by) values ($1, $2) returning id, name
     ), m as (
       insert into company_members (company_id, user_id) select id, $2 from c
     )
     select id, name from c`,
    [input.name, input.createdBy]
  );
  return row;
}

/** The companies `viewer` may open, by name. */
export async function listCompaniesForUser(
  db: Database,
  viewer: Viewer
): Promise<CompanySummary[]> {
  return db.query<CompanySummary>(
    `select c.id, c.name, c.category, c.city, c.country, c.active, c.updated_at
       from companies c
      where ${canAccess(1, 2)}
      order by lower(c.name), c.created_at`,
    [viewer.role, viewer.id]
  );
}

/** The company, only if `viewer` may open it. Otherwise null — same as "doesn't exist". */
export async function findAccessibleCompany(
  db: Database,
  viewer: Viewer,
  companyId: string
): Promise<Company | null> {
  const [row] = await db.query<Company>(
    `select ${COMPANY_COLUMNS} from companies c where c.id = $1 and ${canAccess(2, 3)}`,
    [companyId, viewer.role, viewer.id]
  );
  return row ?? null;
}

/** Adds a user to a company (npm run company:grant). Returns false if already a member. */
export async function addCompanyMember(
  db: Database,
  companyId: string,
  userId: string
): Promise<boolean> {
  const rows = await db.query(
    `insert into company_members (company_id, user_id) values ($1, $2)
     on conflict do nothing returning user_id`,
    [companyId, userId]
  );
  return rows.length > 0;
}

/** Companies whose ID or exact name (any letter case) matches — for the grant command. */
export async function findCompaniesByIdOrName(
  db: Database,
  reference: string
): Promise<{ id: string; name: string }[]> {
  return db.query<{ id: string; name: string }>(
    `select id, name from companies
      where id::text = $1 or lower(name) = lower($1)
      order by created_at`,
    [reference.trim()]
  );
}

// ---------------------------------------------------------------------------
// Deleting a company (admins only — see company/delete-company.ts)
// ---------------------------------------------------------------------------

/** The temporary QC sessions of a company (any designer), so their files can be removed first. */
export async function listCompanySessionIds(db: Database, companyId: string): Promise<string[]> {
  const rows = await db.query<{ id: string }>("select id from qc_sessions where company_id = $1", [companyId]);
  return rows.map((row) => row.id);
}

/** Is the worker analysing (or about to analyse) a design for this company right now? */
export async function hasActiveAnalysis(db: Database, companyId: string): Promise<boolean> {
  const [row] = await db.query<{ busy: boolean }>(
    `select exists (
       select 1 from qc_analysis_runs r join qc_sessions s on s.id = r.session_id
        where s.company_id = $1 and r.status in ('queued', 'processing')
     ) as busy`,
    [companyId]
  );
  return Boolean(row?.busy);
}

/**
 * Deletes the company row — only if nothing new appeared while its files were
 * being removed: no QC session (one started meanwhile would lose its files to
 * the cascade) and the same logo as the one whose file was removed
 * (`expectedLogoPath`, null for none). Checked in the same statement as the
 * delete. Its members, contact details, brand guidelines, Golden Rules and
 * logo record go with it (ON DELETE CASCADE). Returns false if refused.
 */
export async function deleteCompanyRow(db: Database, companyId: string, expectedLogoPath: string | null): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `delete from companies c
      where c.id = $1
        and not exists (select 1 from qc_sessions s where s.company_id = c.id)
        and (select l.storage_path from company_logos l where l.company_id = c.id) is not distinct from $2::text
      returning c.id`,
    [companyId, expectedLogoPath]
  );
  return rows.length === 1;
}
