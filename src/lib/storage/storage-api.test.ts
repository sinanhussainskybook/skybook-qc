import { describe, expect, it, vi } from "vitest";
import { createBucketClient, readStorageConnection, StorageError } from "@/lib/storage/storage-api";
import { readQcBucket } from "@/lib/storage/qc-storage";

const connection = { url: "https://abc.supabase.co", serviceKey: "service-key" };

function fakeFetch(...responses: Response[]) {
  return vi.fn<typeof fetch>(async () => responses.shift() ?? new Response("[]"));
}

describe("SUPABASE_URL must be the bare project address", () => {
  const env = (url: string) => ({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: "k" });

  it("accepts https://<ref>.supabase.co, with or without a trailing slash", () => {
    expect(readStorageConnection(env("https://abc.supabase.co"))).toEqual({ url: "https://abc.supabase.co", serviceKey: "k" });
    expect(readStorageConnection(env("https://abc.supabase.co/"))).toEqual({ url: "https://abc.supabase.co", serviceKey: "k" });
  });

  it("rejects an address with a path such as /rest/v1 (every Storage call would go to the wrong place)", () => {
    for (const url of ["https://abc.supabase.co/rest/v1/", "https://abc.supabase.co/rest/v1", "https://abc.supabase.co/storage/v1", "https://abc.supabase.co?x=1", "https://user:pw@abc.supabase.co"]) {
      expect(readStorageConnection(env(url)), url).toBeNull();
    }
  });

  it("uses a separate temporary bucket for QC files", () => {
    expect(readQcBucket({})).toBe("qc-temp-files");
    expect(readQcBucket({ SUPABASE_QC_BUCKET: "../logos" })).toBeNull();
  });
});

describe("shared Storage client", () => {
  it("makes a one-time upload link for one exact path", async () => {
    const fetchMock = fakeFetch(Response.json({ url: "/object/upload/sign/qc-temp-files/s1/f1.png?token=abc" }));
    const url = await createBucketClient(connection, "qc-temp-files", fetchMock).signedUploadUrl("s1/f1.png");
    expect(url).toBe("https://abc.supabase.co/storage/v1/object/upload/sign/qc-temp-files/s1/f1.png?token=abc");
    const [called, init] = fetchMock.mock.calls[0];
    expect(called).toBe("https://abc.supabase.co/storage/v1/object/upload/sign/qc-temp-files/s1/f1.png");
    expect(init?.headers).toMatchObject({ apikey: "service-key", Authorization: "Bearer service-key" });
  });

  it("reads only the start of a file, and its total size from Content-Range", async () => {
    const fetchMock = fakeFetch(
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 206, headers: { "content-range": "bytes 0-3/9000" } })
    );
    const result = await createBucketClient(connection, "b", fetchMock).readStart("s1/f1.png", 4);
    expect(result).toEqual({ bytes: new Uint8Array([1, 2, 3, 4]), totalSize: 9000 });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Range: "bytes=0-3" });
  });

  it("copes with a server that ignores Range (reads no more than asked)", async () => {
    const fetchMock = fakeFetch(new Response(new Uint8Array(100), { status: 200, headers: { "content-length": "100" } }));
    const result = await createBucketClient(connection, "b", fetchMock).readStart("x", 10);
    expect(result?.bytes.length).toBe(10);
    expect(result?.totalSize).toBe(100);
  });

  it("reports a missing file as null and an empty file as size 0", async () => {
    const client = createBucketClient(
      connection,
      "b",
      fakeFetch(new Response('{"error":"not_found"}', { status: 400 }), new Response("", { status: 416 }))
    );
    expect(await client.readStart("missing", 10)).toBeNull();
    expect(await client.readStart("empty", 10)).toEqual({ bytes: new Uint8Array(), totalSize: 0 });
  });

  it("lists a folder's files (not sub-folders) and removes several at once", async () => {
    const fetchMock = fakeFetch(
      Response.json([{ name: "f1.png", id: "1" }, { name: "sub", id: null }, { name: "f2.pdf", id: "2" }]),
      Response.json([])
    );
    const client = createBucketClient(connection, "b", fetchMock);
    expect(await client.list("s1")).toEqual(["f1.png", "f2.pdf"]);
    await client.remove(["s1/f1.png", "s1/f2.pdf"]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ prefixes: ["s1/f1.png", "s1/f2.pdf"] });
  });

  it("turns failures into StorageError; details never reach people", async () => {
    const client = createBucketClient(connection, "b", fakeFetch(new Response("boom", { status: 500 })));
    await expect(client.list("s1")).rejects.toBeInstanceOf(StorageError);
  });
});
