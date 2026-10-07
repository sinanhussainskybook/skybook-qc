import type { Database } from "@/lib/db/database";
import { FIELD_SECTIONS, type FieldSection } from "@/lib/company/fields";

/**
 * Saves one field of a company's information, contact details or written
 * brand guidelines. The caller must already have checked access to the
 * company and the value (company/actions.ts does both).
 *
 * Column names come only from FIELD_SECTIONS, never from the request.
 */

const TABLES: Record<FieldSection, { table: string; key: string }> = {
  info: { table: "companies", key: "id" },
  contact: { table: "company_contacts", key: "company_id" },
  brand: { table: "brand_profiles", key: "company_id" },
};

export async function saveCompanyField(
  db: Database,
  section: FieldSection,
  companyId: string,
  field: string,
  value: string | null
): Promise<void> {
  if (!Object.hasOwn(FIELD_SECTIONS[section], field)) {
    throw new Error(`Unknown field ${section}.${field}`);
  }
  const { table, key } = TABLES[section];

  if (section === "info") {
    await db.query(
      `update ${table} set ${field} = $2, updated_at = now() where ${key} = $1`,
      [companyId, value]
    );
    return;
  }

  // Contact details and brand text have one row per company, created on first save.
  await db.query(
    `insert into ${table} (${key}, ${field}) values ($1, $2)
     on conflict (${key}) do update set ${field} = excluded.${field}, updated_at = now()`,
    [companyId, value]
  );
  await db.query("update companies set updated_at = now() where id = $1", [companyId]);
}
