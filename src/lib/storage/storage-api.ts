import "server-only";

/**
 * Supabase Storage's REST API, server-side only.
 *
 * Shared by the two private buckets QC uses:
 *   - `company-logos`  — permanent company logos (D3)
 *   - `qc-temp-files`  — temporary QC session files, deleted automatically (D11)
 *
 * Every call uses the server key from SUPABASE_SERVICE_ROLE_KEY — a new
 * secret key (sb_secret_…) or a legacy service_role key — which never
 * reaches the browser. The browser only ever gets a
 * short-lived signed link for one exact file path chosen by the server.
 */

/** Any Storage problem. The message is for logs only — never shown to people. */
export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
  }
}

export type StorageConnection = { url: string; serviceKey: string };

/**
 * The project URL and key, or null when they aren't set or are wrong.
 * SUPABASE_URL must be the bare project address (https://<ref>.supabase.co)
 * — an address with a path such as /rest/v1 is rejected, because every
 * Storage call would go to the wrong place.
 */
export function readStorageConnection(
  env: Record<string, string | undefined> = process.env
): StorageConnection | null {
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) return null;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username) return null;
  return { url: parsed.origin, serviceKey };
}

export function isValidBucketName(bucket: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{1,62}$/.test(bucket);
}

export interface BucketClient {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(paths: string[]): Promise<void>;
  signedUrl(path: string, expiresInSeconds: number): Promise<string>;
  /** A one-time link the browser can upload one file to, at exactly this path. */
  signedUploadUrl(path: string): Promise<string>;
  /** The first `maxBytes` of a stored file and its total size (null if the file doesn't exist). */
  readStart(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; totalSize: number } | null>;
  /** Names of the files directly inside `folder`. */
  list(folder: string): Promise<string[]>;
}

function encodePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function createBucketClient(
  connection: StorageConnection,
  bucket: string,
  fetchImpl: typeof fetch = fetch
): BucketClient {
  const base = `${connection.url}/storage/v1`;
  // Supabase's newer secret keys (sb_secret_…) are not JWTs: they go in `apikey` only — sent as
  // `Authorization: Bearer` they are rejected ("Invalid Compact JWS"). A legacy service_role key is a JWT
  // and keeps both headers, as before.
  const headers: Record<string, string> = connection.serviceKey.startsWith("sb_")
    ? { apikey: connection.serviceKey }
    : { apikey: connection.serviceKey, Authorization: `Bearer ${connection.serviceKey}` };
  const object = (path: string) => `${base}/object/${bucket}/${encodePath(path)}`;

  async function call(what: string, url: string, init: RequestInit, okStatuses: number[] = []) {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      throw new StorageError(`Storage ${what} failed: network error`, { cause: error });
    }
    if (!response.ok && !okStatuses.includes(response.status)) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new StorageError(`Storage ${what} failed: HTTP ${response.status} ${detail}`);
    }
    return response;
  }

  async function signedPath(what: string, url: string, body: object, field: "signedURL" | "url") {
    const response = await call(what, url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const value = data?.[field];
    if (typeof value !== "string" || !value.startsWith("/")) {
      throw new StorageError(`Storage ${what} failed: unexpected response`);
    }
    return `${base}${value}`;
  }

  return {
    async upload(path, bytes, contentType) {
      await call("upload", object(path), {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": contentType,
          "x-upsert": "false", // every file gets a new path; never overwrite
          "cache-control": "max-age=3600",
        },
        body: bytes as unknown as BodyInit,
      });
    },

    async remove(paths) {
      if (paths.length === 0) return;
      await call("delete", `${base}/object/${bucket}`, {
        method: "DELETE",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: paths }),
      });
    },

    signedUrl(path, expiresInSeconds) {
      return signedPath("sign", `${base}/object/sign/${bucket}/${encodePath(path)}`, { expiresIn: expiresInSeconds }, "signedURL");
    },

    signedUploadUrl(path) {
      return signedPath("upload-sign", `${base}/object/upload/sign/${bucket}/${encodePath(path)}`, {}, "url");
    },

    async readStart(path, maxBytes) {
      const response = await call(
        "read",
        `${base}/object/authenticated/${bucket}/${encodePath(path)}`,
        { method: "GET", headers: { ...headers, Range: `bytes=0-${maxBytes - 1}` } },
        [400, 404, 416]
      );
      if (response.status === 400 || response.status === 404) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      if (response.status === 416) {
        // "Range not satisfiable": the file exists but is empty.
        await response.body?.cancel().catch(() => {});
        return { bytes: new Uint8Array(), totalSize: 0 };
      }

      // Read at most maxBytes, whether or not the server honoured the Range header.
      const chunks: Uint8Array[] = [];
      let received = 0;
      const reader = response.body?.getReader();
      while (reader && received < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
      }
      await reader?.cancel().catch(() => {});
      const bytes = new Uint8Array(Math.min(received, maxBytes));
      let offset = 0;
      for (const chunk of chunks) {
        const take = Math.min(chunk.length, bytes.length - offset);
        bytes.set(chunk.subarray(0, take), offset);
        offset += take;
        if (offset >= bytes.length) break;
      }

      const range = /\/(\d+)\s*$/.exec(response.headers.get("content-range") ?? "");
      const totalSize = range
        ? Number(range[1])
        : response.status === 200
          ? Number(response.headers.get("content-length") ?? received)
          : NaN;
      if (!Number.isFinite(totalSize)) throw new StorageError("Storage read failed: size unknown");
      return { bytes, totalSize };
    },

    async list(folder) {
      const names: string[] = [];
      for (let offset = 0; ; offset += 100) {
        const response = await call("list", `${base}/object/list/${bucket}`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ prefix: folder, limit: 100, offset }),
        });
        const page = (await response.json().catch(() => [])) as { name?: unknown; id?: unknown }[];
        // Folders come back with id null; only real files are returned.
        for (const item of page) if (typeof item.name === "string" && item.id !== null) names.push(item.name);
        if (page.length < 100) break;
      }
      return names;
    },
  };
}
