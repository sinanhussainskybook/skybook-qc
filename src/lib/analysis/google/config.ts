import { existsSync } from "node:fs";

/**
 * Google Cloud settings for the analysis worker (D5, locked 2026-10-04).
 * Read on the server only, from the environment (the existing external
 * secrets file at <home>/.skybook-qc/.env.local, or the host's settings):
 *
 *   GOOGLE_CLOUD_PROJECT            the Google Cloud project id
 *   GOOGLE_APPLICATION_CREDENTIALS  path to the service-account key file —
 *                                   keep it OUTSIDE the project / OneDrive
 *   QC_GOOGLE_REGION                eu — the only allowed value (approved data region)
 *   QC_GEMINI_MODEL                 gemini-3.8-flash (default)
 *
 * Only the EU multi-region is accepted (global and every other region are
 * refused): processing stays in the EU. Values are never printed; errors name the setting only.
 */

export type GoogleConfig = {
  project: string;
  region: "eu";
  model: string;
  credentialsFile: string;
  visionUrl: string;
  geminiUrl: string;
};

export const GOOGLE_ENDPOINTS = {
  eu: { vision: "https://eu-vision.googleapis.com", gemini: "https://aiplatform.eu.rep.googleapis.com" },
} as const;

export function readGoogleConfig(env: Record<string, string | undefined> = process.env): { ok: true; value: GoogleConfig } | { ok: false; error: string } {
  const project = env.GOOGLE_CLOUD_PROJECT?.trim() ?? "";
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) return { ok: false, error: "GOOGLE_CLOUD_PROJECT is missing or not a valid project id." };
  const region = (env.QC_GOOGLE_REGION?.trim().toLowerCase() || "eu") as string;
  if (region === "global") return { ok: false, error: "QC_GOOGLE_REGION=global isn't allowed — use eu." };
  if (region !== "eu") return { ok: false, error: "QC_GOOGLE_REGION must be eu." };
  const model = env.QC_GEMINI_MODEL?.trim() || "gemini-3.8-flash";
  if (!/^gemini-[a-z0-9.-]{1,60}$/.test(model)) return { ok: false, error: "QC_GEMINI_MODEL isn't a Gemini model id." };
  const credentialsFile = env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ?? "";
  if (!credentialsFile || !existsSync(credentialsFile)) return { ok: false, error: "GOOGLE_APPLICATION_CREDENTIALS doesn't point to a key file." };
  const endpoints = GOOGLE_ENDPOINTS[region];
  return {
    ok: true,
    value: {
      project,
      region,
      model,
      credentialsFile,
      visionUrl: `${endpoints.vision}/v1/projects/${project}/locations/${region}/images:annotate`,
      geminiUrl: `${endpoints.gemini}/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:generateContent`,
    },
  };
}
