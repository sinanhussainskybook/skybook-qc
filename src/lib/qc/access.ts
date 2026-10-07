import "server-only";
import { getDatabase } from "@/lib/db/client";
import { findOwnedSession, type QcSession } from "@/lib/db/qc-sessions";
import type { User } from "@/lib/db/users";
import { requireUser } from "@/lib/auth/current-user";
import { findCompanyForUser } from "@/lib/company/access";
import type { Company } from "@/lib/company/types";
import { isUuid } from "@/lib/company/validation";

/**
 * Who may use a QC session. Reuses the existing sign-in and company-access
 * rules (D13) and adds one: a session belongs to the designer who started
 * it — nobody else, admins included, can open or change it.
 *
 * Every QC action calls this with the session ID from the form. It checks:
 *   1. signed in (otherwise → sign-in page);
 *   2. the session exists, hasn't expired and belongs to this user;
 *   3. the user may still open the session's company.
 * Anything else is "not available" — the same answer whether the ID is
 * forged, another designer's, expired or of a company you left.
 */
export async function findSessionForUser(
  sessionId: unknown,
  now: Date = new Date()
): Promise<{ user: User; session: QcSession; company: Company } | null> {
  const user = await requireUser();
  if (!isUuid(sessionId)) return null;
  const session = await findOwnedSession(getDatabase(), sessionId, user.id, now);
  if (!session) return null;
  const company = await findCompanyForUser(user, session.company_id);
  if (!company) return null;
  return { user, session, company };
}
