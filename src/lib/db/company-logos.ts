import type { Database } from "@/lib/db/database";

/**
 * Logo metadata (table `company_logos`, D3). The file itself is in
 * Supabase Storage — see lib/storage/. At most one row per company.
 * The caller must already have checked access to the company.
 */

export type CompanyLogo = {
  id: string;
  file_name: string;
  storage_path: string;
  mime_type: string;
  file_size: number;
  created_at: Date;
  updated_at: Date;
};

const COLUMNS = "id, file_name, storage_path, mime_type, file_size, created_at, updated_at";

export async function getCompanyLogo(db: Database, companyId: string): Promise<CompanyLogo | null> {
  const [row] = await db.query<CompanyLogo>(
    `select ${COLUMNS} from company_logos where company_id = $1`,
    [companyId]
  );
  return row ?? null;
}

/**
 * Saves the company's one logo, replacing any previous one. Returns the
 * previous file's storage path (to delete from Storage), or null.
 */
export async function upsertCompanyLogo(
  db: Database,
  companyId: string,
  logo: { fileName: string; storagePath: string; mimeType: string; fileSize: number }
): Promise<{ previousPath: string | null }> {
  // `old` locks and reads the current row first (a replace running at the
  // same moment waits, then sees this one's path), then it is updated —
  // or, if there was none, a row is inserted. A second insert racing for a
  // company with no logo fails on the unique company_id and is reported.
  const [row] = await db.query<{ previous_path: string | null }>(
    `with old as (
       select id, storage_path from company_logos where company_id = $1 for update
     ), updated as (
       update company_logos c set
         file_name = $2, storage_path = $3, mime_type = $4, file_size = $5, updated_at = now()
       from old where c.id = old.id
       returning old.storage_path as previous_path
     ), inserted as (
       insert into company_logos (company_id, file_name, storage_path, mime_type, file_size)
       select $1, $2, $3, $4, $5 where not exists (select 1 from old)
       returning null::text as previous_path
     )
     select previous_path from updated
     union all
     select previous_path from inserted`,
    [companyId, logo.fileName, logo.storagePath, logo.mimeType, logo.fileSize]
  );
  return { previousPath: row.previous_path };
}

/** Removes the company's logo metadata. Returns the file's storage path, or null if there was none. */
export async function deleteCompanyLogo(db: Database, companyId: string): Promise<string | null> {
  const [row] = await db.query<{ storage_path: string }>(
    "delete from company_logos where company_id = $1 returning storage_path",
    [companyId]
  );
  return row?.storage_path ?? null;
}
