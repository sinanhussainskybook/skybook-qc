import type { LogoStorage } from "@/lib/storage/logo-storage";
import { LogoStorageError } from "@/lib/storage/logo-storage";
import type { BucketClient } from "@/lib/storage/storage-api";
import { StorageError } from "@/lib/storage/storage-api";

/**
 * An in-memory stand-in for a whole Storage bucket (QC temporary files).
 * `browserPut` plays the part of the browser uploading to a signed link.
 */
export function createFakeBucket() {
  const files = new Map<string, Uint8Array>();
  const uploadLinks = new Set<string>();
  const failing = { remove: false, list: false, sign: false, read: false };
  const calls: string[] = [];

  const bucket: BucketClient = {
    async upload(path, bytes) {
      files.set(path, bytes);
    },
    async remove(paths) {
      calls.push(`remove ${paths.join(",")}`);
      if (failing.remove) throw new StorageError("fake remove failure");
      for (const path of paths) files.delete(path);
    },
    async signedUrl(path) {
      return `https://storage.test/sign/${path}`;
    },
    async signedUploadUrl(path) {
      calls.push(`upload-link ${path}`);
      if (failing.sign) throw new StorageError("fake sign failure");
      uploadLinks.add(path);
      return `https://storage.test/upload/${path}?token=t`;
    },
    async readStart(path, maxBytes) {
      if (failing.read) throw new StorageError("fake read failure");
      const bytes = files.get(path);
      return bytes ? { bytes: bytes.subarray(0, maxBytes), totalSize: bytes.length } : null;
    },
    async list(folder) {
      if (failing.list) throw new StorageError("fake list failure");
      return [...files.keys()].filter((p) => p.startsWith(`${folder}/`)).map((p) => p.slice(folder.length + 1));
    },
  };

  /** The browser uploading to a link the server handed out (refused for any other path). */
  function browserPut(uploadUrl: string, bytes: Uint8Array) {
    const path = new URL(uploadUrl).pathname.replace(/^\/upload\//, "");
    if (!uploadLinks.has(path)) throw new Error(`no upload link for ${path}`);
    files.set(path, bytes);
    return path;
  }

  return { bucket, files, failing, calls, browserPut };
}

/**
 * An in-memory stand-in for Supabase Storage. Each operation can be told
 * to fail, to test what happens when Storage is down part-way.
 */
export function createFakeStorage() {
  const files = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const failing = { upload: false, remove: false, sign: false };
  const calls: string[] = [];

  const storage: LogoStorage = {
    async upload(path, bytes, contentType) {
      calls.push(`upload ${path}`);
      if (failing.upload) throw new LogoStorageError("fake upload failure");
      if (files.has(path)) throw new LogoStorageError("fake: already exists");
      files.set(path, { bytes, contentType });
    },
    async remove(path) {
      calls.push(`remove ${path}`);
      if (failing.remove) throw new LogoStorageError("fake remove failure");
      files.delete(path);
    },
    async signedUrl(path, expiresInSeconds) {
      calls.push(`sign ${path}`);
      if (failing.sign) throw new LogoStorageError("fake sign failure");
      return `https://storage.test/sign/${path}?expires=${expiresInSeconds}`;
    },
  };

  return { storage, files, failing, calls };
}
