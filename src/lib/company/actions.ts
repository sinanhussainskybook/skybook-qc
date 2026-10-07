"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDatabase } from "@/lib/db/client";
import { insertCompany } from "@/lib/db/companies";
import { saveCompanyField } from "@/lib/db/company-fields";
import {
  deleteItem,
  insertItem,
  setGoldenRuleActive,
  updateItem,
} from "@/lib/db/company-lists";
import { requireUser } from "@/lib/auth/current-user";
import { findCompanyForUser } from "@/lib/company/access";
import { checkListItem, findFieldSpec, isListKind, type FieldSection } from "@/lib/company/fields";
import { checkCompanyName, isUuid } from "@/lib/company/validation";

/**
 * Server actions for the company pages. Each one:
 *   1. requires a signed-in user (signed out → sign-in page),
 *   2. checks the user may open the company named in the form (D13),
 *   3. checks every value on the server, whatever the browser sent,
 *   4. saves only through lib/db, which scopes every change to that company.
 */

const NOT_AVAILABLE = "This company isn't available. Reload the page and try again.";
const SAVE_FAILED = "That couldn't be saved. Please try again.";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

async function companyFromForm(formData: FormData) {
  const user = await requireUser();
  const company = await findCompanyForUser(user, field(formData, "companyId"));
  return company;
}

function refresh(companyId: string) {
  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Add company
// ---------------------------------------------------------------------------

export type CreateCompanyState = { error?: string; name?: string };

export async function createCompanyAction(
  _previous: CreateCompanyState,
  formData: FormData
): Promise<CreateCompanyState> {
  const user = await requireUser();
  const raw = field(formData, "name");
  const name = checkCompanyName(raw);
  if (!name.ok) return { error: name.error, name: raw };

  let id: string;
  try {
    ({ id } = await insertCompany(getDatabase(), { name: name.value, createdBy: user.id }));
  } catch (error) {
    console.error("Create company failed:", error);
    return { error: SAVE_FAILED, name: raw };
  }
  revalidatePath("/");
  redirect(`/companies/${id}`);
}

// ---------------------------------------------------------------------------
// One field at a time (information, contact, written brand guidelines)
// ---------------------------------------------------------------------------

export type FieldFormState = { ok?: boolean; error?: string };

export async function saveCompanyFieldAction(
  _previous: FieldFormState,
  formData: FormData
): Promise<FieldFormState> {
  const section = field(formData, "section");
  const name = field(formData, "field");
  const spec = findFieldSpec(section, name);
  if (!spec) return { error: "This field can't be edited." };

  const company = await companyFromForm(formData);
  if (!company) return { error: NOT_AVAILABLE };

  const checked = spec.check(field(formData, "value"));
  if (!checked.ok) return { error: checked.error };

  try {
    await saveCompanyField(
      getDatabase(),
      section as FieldSection,
      company.id,
      name,
      checked.value as string | null
    );
  } catch (error) {
    console.error("Save company field failed:", error);
    return { error: SAVE_FAILED };
  }
  refresh(company.id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Lists: colours, fonts, terms, Golden Rules
// ---------------------------------------------------------------------------

export type ListItemFormState = {
  ok?: boolean;
  error?: string;
  errors?: Record<string, string>;
};

// The form names the list in "list" — not "kind", which is a column of brand_terms.

/** Adds an item, or edits it when the form has an itemId. */
export async function saveListItemAction(
  _previous: ListItemFormState,
  formData: FormData
): Promise<ListItemFormState> {
  const kind = field(formData, "list");
  if (!isListKind(kind)) return { error: "This list can't be edited." };
  const itemId = field(formData, "itemId");
  if (itemId && !isUuid(itemId)) return { error: NOT_AVAILABLE };

  const company = await companyFromForm(formData);
  if (!company) return { error: NOT_AVAILABLE };

  const checked = checkListItem(kind, (name) => field(formData, name));
  if (!checked.ok) return { errors: checked.errors };

  try {
    const db = getDatabase();
    if (itemId) {
      const found = await updateItem(db, kind, company.id, itemId, checked.values);
      if (!found) return { error: NOT_AVAILABLE };
    } else {
      await insertItem(db, kind, company.id, checked.values);
    }
  } catch (error) {
    console.error("Save list item failed:", error);
    return { error: SAVE_FAILED };
  }
  refresh(company.id);
  return { ok: true };
}

export async function deleteListItemAction(
  _previous: ListItemFormState,
  formData: FormData
): Promise<ListItemFormState> {
  const kind = field(formData, "list");
  const itemId = field(formData, "itemId");
  if (!isListKind(kind) || !isUuid(itemId)) return { error: NOT_AVAILABLE };

  const company = await companyFromForm(formData);
  if (!company) return { error: NOT_AVAILABLE };

  try {
    const found = await deleteItem(getDatabase(), kind, company.id, itemId);
    if (!found) return { error: NOT_AVAILABLE };
  } catch (error) {
    console.error("Remove list item failed:", error);
    return { error: SAVE_FAILED };
  }
  refresh(company.id);
  return { ok: true };
}

export async function setGoldenRuleActiveAction(
  _previous: ListItemFormState,
  formData: FormData
): Promise<ListItemFormState> {
  const ruleId = field(formData, "itemId");
  const active = field(formData, "active");
  if (!isUuid(ruleId) || (active !== "true" && active !== "false")) {
    return { error: NOT_AVAILABLE };
  }

  const company = await companyFromForm(formData);
  if (!company) return { error: NOT_AVAILABLE };

  try {
    const found = await setGoldenRuleActive(getDatabase(), company.id, ruleId, active === "true");
    if (!found) return { error: NOT_AVAILABLE };
  } catch (error) {
    console.error("Switch Golden Rule failed:", error);
    return { error: SAVE_FAILED };
  }
  refresh(company.id);
  return { ok: true };
}
