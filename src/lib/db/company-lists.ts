import type { Database } from "@/lib/db/database";
import { LIST_SPECS, type ListKind, type ListValues } from "@/lib/company/fields";
import type { ListItems } from "@/lib/company/types";

/**
 * Brand colours, fonts, terms and Golden Rules: lists of items that belong
 * to one company.
 *
 * Every statement includes `company_id = …`, so an item can only be read,
 * changed or removed through its own company — a Golden Rule ID from
 * company A sent with company B's ID changes nothing. The table name is the
 * list kind and the columns come from LIST_SPECS, never from the request.
 */

function columnsOf(kind: ListKind): string[] {
  return Object.keys(LIST_SPECS[kind].fields);
}

export async function listItems<K extends ListKind>(
  db: Database,
  kind: K,
  companyId: string
): Promise<ListItems[K]> {
  return db.query(
    `select * from ${kind} where company_id = $1 order by created_at, id`,
    [companyId]
  ) as Promise<ListItems[K]>;
}

export async function insertItem(
  db: Database,
  kind: ListKind,
  companyId: string,
  values: ListValues
): Promise<string> {
  const columns = columnsOf(kind);
  const placeholders = columns.map((_, i) => `$${i + 2}`);
  const [row] = await db.query<{ id: string }>(
    `insert into ${kind} (company_id, ${columns.join(", ")})
     values ($1, ${placeholders.join(", ")}) returning id`,
    [companyId, ...columns.map((column) => values[column] ?? null)]
  );
  await touchCompany(db, companyId);
  return row.id;
}

/** Returns false if the item doesn't exist in this company. */
export async function updateItem(
  db: Database,
  kind: ListKind,
  companyId: string,
  itemId: string,
  values: ListValues
): Promise<boolean> {
  const columns = columnsOf(kind);
  const assignments = columns.map((column, i) => `${column} = $${i + 3}`);
  const rows = await db.query(
    `update ${kind} set ${assignments.join(", ")}, updated_at = now()
      where id = $1 and company_id = $2 returning id`,
    [itemId, companyId, ...columns.map((column) => values[column] ?? null)]
  );
  if (rows.length > 0) await touchCompany(db, companyId);
  return rows.length > 0;
}

/** Returns false if the item doesn't exist in this company. */
export async function deleteItem(
  db: Database,
  kind: ListKind,
  companyId: string,
  itemId: string
): Promise<boolean> {
  const rows = await db.query(
    `delete from ${kind} where id = $1 and company_id = $2 returning id`,
    [itemId, companyId]
  );
  if (rows.length > 0) await touchCompany(db, companyId);
  return rows.length > 0;
}

/** Switch a Golden Rule on or off. Returns false if it isn't in this company. */
export async function setGoldenRuleActive(
  db: Database,
  companyId: string,
  ruleId: string,
  active: boolean
): Promise<boolean> {
  const rows = await db.query(
    `update golden_rules set active = $3, updated_at = now()
      where id = $1 and company_id = $2 returning id`,
    [ruleId, companyId, active]
  );
  if (rows.length > 0) await touchCompany(db, companyId);
  return rows.length > 0;
}

async function touchCompany(db: Database, companyId: string) {
  await db.query("update companies set updated_at = now() where id = $1", [companyId]);
}
