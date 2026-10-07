"use server";

import { revalidatePath } from "next/cache";
import { getDatabase } from "@/lib/db/client";
import { requireUser } from "@/lib/auth/current-user";
import { findCompanyForUser } from "@/lib/company/access";
import { checkLogoFile, LOGO_MAX_BYTES, LOGO_MESSAGES } from "@/lib/company/logo-file";
import { removeCompanyLogo, saveCompanyLogo, type LogoResult } from "@/lib/company/logo";
import { getLogoStorage } from "@/lib/storage/logo-storage";

/**
 * Upload / replace and remove a company logo (D3). Each action:
 *   1. requires a signed-in user,
 *   2. checks the user may open the company in the form (D13),
 *   3. checks the file on the server,
 *   4. works only on that authorised company — the storage path is made
 *      on the server from its ID.
 * Messages are friendly; raw Storage / database errors go to the server log only.
 */

export type LogoFormState = { ok?: boolean; message?: string; error?: string };

const MESSAGES = {
  notAvailable: "This company isn't available. Reload the page and try again.",
  notConfigured: "Logo storage isn't set up on this server yet. Ask your administrator.",
  storage: "The logo couldn't be saved to storage. Please try again in a moment.",
  database: "The logo couldn't be saved. Please try again.",
  noLogo: "There's no logo to remove.",
  uploaded: "Logo saved.",
  removed: "Logo removed.",
};

async function authorisedCompanyId(formData: FormData): Promise<string | null> {
  const user = await requireUser();
  const company = await findCompanyForUser(user, formData.get("companyId"));
  return company?.id ?? null;
}

function failure(result: Extract<LogoResult, { ok: false }>): LogoFormState {
  if (result.reason === "no-logo") return { error: MESSAGES.noLogo };
  return { error: result.reason === "storage" ? MESSAGES.storage : MESSAGES.database };
}

export async function uploadLogoAction(
  _previous: LogoFormState,
  formData: FormData
): Promise<LogoFormState> {
  const companyId = await authorisedCompanyId(formData);
  if (!companyId) return { error: MESSAGES.notAvailable };

  const file = formData.get("logo");
  if (!(file instanceof File) || (file.size === 0 && file.name === "")) {
    return { error: LOGO_MESSAGES.missing };
  }
  // Don't read a file bigger than the limit into memory.
  if (file.size > LOGO_MAX_BYTES) return { error: LOGO_MESSAGES.tooLarge };

  const checked = checkLogoFile({
    name: file.name,
    type: file.type,
    size: file.size,
    bytes: new Uint8Array(await file.arrayBuffer()),
  });
  if (!checked.ok) return { error: checked.error };

  const storage = getLogoStorage();
  if (!storage) return { error: MESSAGES.notConfigured };

  const result = await saveCompanyLogo(getDatabase(), storage, companyId, checked.value);
  if (!result.ok) return failure(result);

  revalidatePath(`/companies/${companyId}`);
  return { ok: true, message: MESSAGES.uploaded };
}

export async function removeLogoAction(
  _previous: LogoFormState,
  formData: FormData
): Promise<LogoFormState> {
  const companyId = await authorisedCompanyId(formData);
  if (!companyId) return { error: MESSAGES.notAvailable };

  const storage = getLogoStorage();
  if (!storage) return { error: MESSAGES.notConfigured };

  const result = await removeCompanyLogo(getDatabase(), storage, companyId);
  if (!result.ok) return failure(result);

  revalidatePath(`/companies/${companyId}`);
  return { ok: true, message: MESSAGES.removed };
}
