import type { Database } from "@/lib/db/database";
import { loadCompanyConfiguration } from "@/lib/db/company-config";
import { listFiles, listRequirements, type QcFile, type QcRequirement, type QcSession } from "@/lib/db/qc-sessions";
import type { Company, CompanyConfiguration } from "@/lib/company/types";
import type { ContentType } from "@/lib/qc/content-types";
import type { RequirementSource } from "@/lib/qc/requirements";
import { customChoiceOf, fileFactsOf, type CustomChoice } from "@/lib/qc/rules/platform-size";
import type { MediaInfo } from "@/lib/qc/media-info";

/**
 * Everything the QC engine (Phases 5–6) will read for one check, as ONE
 * object: the company's saved configuration (from the existing loader —
 * not copied into the session) plus this session's content type, confirmed
 * requirements and files.
 *
 * Only CONFIRMED requirements are included — typed or, later, extracted by
 * AI and then reviewed. Unconfirmed ones are only counted.
 */

export type QcInputRequirement = {
  type: string;
  label: string | null;
  expectedValue: string;
  notes: string | null;
  mandatory: boolean;
  source: RequirementSource;
};

export type QcInputFile = {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  /** Where the file is in the temporary bucket — read server-side only. */
  storagePath: string;
  /** Measured from the content when it was uploaded (Phase 5); null if not measured. */
  media: MediaInfo | null;
};

export type QcInput = {
  company: CompanyConfiguration;
  session: {
    id: string;
    contentType: ContentType;
    status: QcSession["status"];
    /** Platform / placement keys (lib/qc/platforms.ts), or a typed custom size. */
    platform: string | null;
    placement: string | null;
    custom: CustomChoice | null;
  };
  requirements: QcInputRequirement[];
  unconfirmedRequirementCount: number;
  informationFiles: QcInputFile[];
  contentFiles: QcInputFile[];
};

export async function loadQcInput(db: Database, company: Company, session: QcSession): Promise<QcInput> {
  if (session.company_id !== company.id) throw new Error("Session and company don't match.");

  const [configuration, requirements, files] = await Promise.all([
    loadCompanyConfiguration(db, company),
    listRequirements(db, session.id),
    listFiles(db, session.id, "ready"),
  ]);
  return toQcInput(configuration, session, requirements, files);
}

/** The same input from rows already loaded (the Start QC page has them). Ready files only. */
export function toQcInput(
  configuration: CompanyConfiguration,
  session: QcSession,
  requirements: QcRequirement[],
  files: QcFile[]
): QcInput {
  if (session.company_id !== configuration.company.id) throw new Error("Session and company don't match.");
  const ready = files.filter((f) => f.status === "ready");
  const toFile = (file: QcFile): QcInputFile => ({
    id: file.id,
    fileName: file.file_name,
    mimeType: file.mime_type,
    fileSize: file.file_size,
    storagePath: file.storage_path,
    media: fileFactsOf(file).media,
  });

  return {
    company: configuration,
    session: {
      id: session.id,
      contentType: session.content_type,
      status: session.status,
      platform: session.platform,
      placement: session.placement,
      custom: customChoiceOf(session),
    },
    requirements: requirements
      .filter((r) => r.confirmed)
      .map((r) => ({
        type: r.type,
        label: r.label,
        expectedValue: r.expected_value,
        notes: r.notes,
        mandatory: r.mandatory,
        source: r.source,
      })),
    unconfirmedRequirementCount: requirements.filter((r) => !r.confirmed).length,
    informationFiles: ready.filter((f) => f.kind === "information").map(toFile),
    contentFiles: ready.filter((f) => f.kind === "content").map(toFile),
  };
}

/**
 * Company information that's missing, so the designer knows those checks
 * will come back as "not verified" once QC runs (never as a failure).
 */
export function missingCompanyInformation(config: CompanyConfiguration): string[] {
  const missing: string[] = [];
  const { contact, brand } = config;
  if (!contact.phone && !contact.whatsapp && !contact.email && !contact.website) missing.push("contact details");
  if (!config.logo) missing.push("logo");
  if (brand.colors.length === 0) missing.push("brand colours");
  if (brand.fonts.length === 0) missing.push("fonts");
  if (config.goldenRules.filter((rule) => rule.active).length === 0) missing.push("Golden Rules");
  return missing;
}
