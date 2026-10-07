import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseLogoStorage,
  LogoStorageError,
  readStorageConfig,
} from "@/lib/storage/logo-storage";

const config = { url: "https://abc.supabase.co", serviceKey: "service-key", bucket: "company-logos" };

function fakeFetch(response: Response | Error) {
  return vi.fn<typeof fetch>(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
}

describe("Supabase Storage client (logos)", () => {
  it("uploads to the private bucket with the server key, never overwriting", async () => {
    const fetchMock = fakeFetch(new Response("{}", { status: 200 }));
    const storage = createSupabaseLogoStorage(config, fetchMock as typeof fetch);
    await storage.upload("c1/f1.png", new Uint8Array([1, 2]), "image/png");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://abc.supabase.co/storage/v1/object/company-logos/c1/f1.png");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      apikey: "service-key",
      Authorization: "Bearer service-key",
      "Content-Type": "image/png",
      "x-upsert": "false",
    });
  });

  it("removes by path", async () => {
    const fetchMock = fakeFetch(new Response("[]", { status: 200 }));
    await createSupabaseLogoStorage(config, fetchMock as typeof fetch).remove("c1/f1.png");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://abc.supabase.co/storage/v1/object/company-logos");
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(String(init?.body))).toEqual({ prefixes: ["c1/f1.png"] });
  });

  it("makes a signed link with an expiry", async () => {
    const fetchMock = fakeFetch(
      Response.json({ signedURL: "/object/sign/company-logos/c1/f1.png?token=abc" })
    );
    const url = await createSupabaseLogoStorage(config, fetchMock as typeof fetch).signedUrl("c1/f1.png", 3600);
    expect(url).toBe("https://abc.supabase.co/storage/v1/object/sign/company-logos/c1/f1.png?token=abc");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ expiresIn: 3600 });
  });

  it("turns every failure into a LogoStorageError (details for logs only)", async () => {
    const down = createSupabaseLogoStorage(config, fakeFetch(new TypeError("fetch failed")) as typeof fetch);
    await expect(down.upload("c1/f.png", new Uint8Array([1]), "image/png")).rejects.toBeInstanceOf(LogoStorageError);

    const refused = createSupabaseLogoStorage(
      config,
      fakeFetch(new Response('{"error":"Bucket not found"}', { status: 404 })) as typeof fetch
    );
    await expect(refused.remove("c1/f.png")).rejects.toThrow(/HTTP 404/);

    const odd = createSupabaseLogoStorage(config, fakeFetch(Response.json({ nope: 1 })) as typeof fetch);
    await expect(odd.signedUrl("c1/f.png", 60)).rejects.toBeInstanceOf(LogoStorageError);
  });
});

describe("Storage settings", () => {
  it("needs a URL and the service key; bucket defaults to company-logos", () => {
    expect(readStorageConfig({ SUPABASE_URL: "https://abc.supabase.co/", SUPABASE_SERVICE_ROLE_KEY: "k" })).toEqual({
      url: "https://abc.supabase.co",
      serviceKey: "k",
      bucket: "company-logos",
    });
    expect(readStorageConfig({})).toBeNull();
    expect(readStorageConfig({ SUPABASE_URL: "https://abc.supabase.co" })).toBeNull();
  });

  it("requires https, except for a local test server", () => {
    const env = (url: string) => ({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: "k" });
    expect(readStorageConfig(env("http://abc.supabase.co"))).toBeNull();
    expect(readStorageConfig(env("not a url"))).toBeNull();
    expect(readStorageConfig(env("http://127.0.0.1:54321"))).not.toBeNull();
  });

  it("rejects an odd bucket name", () => {
    expect(
      readStorageConfig({ SUPABASE_URL: "https://a.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k", SUPABASE_LOGO_BUCKET: "../x" })
    ).toBeNull();
  });
});
