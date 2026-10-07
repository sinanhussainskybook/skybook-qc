import "server-only";
import {
  createBucketClient,
  isValidBucketName,
  readStorageConnection,
  type BucketClient,
} from "@/lib/storage/storage-api";

/**
 * The TEMPORARY private bucket for QC session files (D11): uploaded
 * information and the content being checked. Separate from the permanent
 * `company-logos` bucket, so session files can never become company assets.
 *
 * Files live at `{sessionId}/{fileId}.{ext}` — paths made by the server —
 * and are deleted with their session (24 hours after its last change, or on
 * Start over). Never a design library or history.
 */

export const DEFAULT_QC_BUCKET = "qc-temp-files";

export type QcStorage = BucketClient;

export function readQcBucket(env: Record<string, string | undefined> = process.env): string | null {
  const bucket = env.SUPABASE_QC_BUCKET?.trim() || DEFAULT_QC_BUCKET;
  return isValidBucketName(bucket) ? bucket : null;
}

/** The QC file storage, or null when Supabase Storage isn't set up on this server. */
export function getQcStorage(): QcStorage | null {
  const connection = readStorageConnection();
  const bucket = readQcBucket();
  return connection && bucket ? createBucketClient(connection, bucket) : null;
}
