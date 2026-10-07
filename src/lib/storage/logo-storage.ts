import "server-only";
import {
  createBucketClient,
  isValidBucketName,
  readStorageConnection,
  StorageError,
} from "@/lib/storage/storage-api";

/**
 * Supabase Storage for company logos only (D3). Nothing else is ever
 * stored here: no designs, content, requirement files, temporary QC files
 * or reports (those use the separate temporary bucket — lib/storage/qc-storage.ts).
 *
 * Server-side only, through the shared REST client in storage-api.ts. The
 * bucket is private; people see a logo through a short-lived signed link
 * made after the app's own checks.
 */

export interface LogoStorage {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(path: string): Promise<void>;
  signedUrl(path: string, expiresInSeconds: number): Promise<string>;
}

/** Any Storage problem (same class as StorageError). Logs only — never shown to people. */
export { StorageError as LogoStorageError };

export const DEFAULT_LOGO_BUCKET = "company-logos";

/** How long a link to a logo image stays valid. */
export const LOGO_LINK_SECONDS = 60 * 60;

export type StorageConfig = { url: string; serviceKey: string; bucket: string };

/** The Storage settings for logos, or null when they aren't set up correctly. */
export function readStorageConfig(
  env: Record<string, string | undefined> = process.env
): StorageConfig | null {
  const connection = readStorageConnection(env);
  const bucket = env.SUPABASE_LOGO_BUCKET?.trim() || DEFAULT_LOGO_BUCKET;
  if (!connection || !isValidBucketName(bucket)) return null;
  return { ...connection, bucket };
}

export function createSupabaseLogoStorage(
  config: StorageConfig,
  fetchImpl: typeof fetch = fetch
): LogoStorage {
  const bucket = createBucketClient(config, config.bucket, fetchImpl);
  return {
    upload: (path, bytes, contentType) => bucket.upload(path, bytes, contentType),
    remove: (path) => bucket.remove([path]),
    signedUrl: (path, expiresInSeconds) => bucket.signedUrl(path, expiresInSeconds),
  };
}

/** The configured logo storage, or null when Supabase Storage isn't set up on this server. */
export function getLogoStorage(): LogoStorage | null {
  const config = readStorageConfig();
  return config ? createSupabaseLogoStorage(config) : null;
}
