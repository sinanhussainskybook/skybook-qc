import { afterEach, describe, expect, it, vi } from "vitest";
import { DESIGN_PREVIEW_SECONDS, designPreviews } from "@/lib/qc/design-preview";

/** The checked design shown beside the QC result: short-lived links to images only, never a slow page. */

const file = (id: string, mime_type: string, kind: "content" | "information" = "content") => ({
  id,
  kind,
  file_name: `${id}.${mime_type.split("/")[1]}`,
  storage_path: `s1/${id}`,
  mime_type,
  media_width: 1080,
  media_height: 1350,
});
const storage = (signedUrl = vi.fn(async (path: string, seconds: number) => `https://storage.test/sign/${path}?expires=${seconds}`)) => ({ signedUrl });

describe("designPreviews", () => {
  afterEach(() => vi.restoreAllMocks());

  it("gives each design image a short-lived link, with its size; the brief is never shown", async () => {
    const s = storage();
    const previews = await designPreviews(s, [file("brief", "application/pdf", "information"), file("a", "image/png"), file("b", "image/jpeg"), file("c", "image/webp")]);
    expect(previews).toEqual([
      { id: "a", fileName: "a.png", url: `https://storage.test/sign/s1/a?expires=${DESIGN_PREVIEW_SECONDS}`, width: 1080, height: 1350 },
      { id: "b", fileName: "b.jpeg", url: `https://storage.test/sign/s1/b?expires=${DESIGN_PREVIEW_SECONDS}`, width: 1080, height: 1350 },
      { id: "c", fileName: "c.webp", url: `https://storage.test/sign/s1/c?expires=${DESIGN_PREVIEW_SECONDS}`, width: 1080, height: 1350 },
    ]);
    expect(s.signedUrl).not.toHaveBeenCalledWith("s1/brief", expect.anything());
  });

  it("a PDF or video design is listed by name, without a link", async () => {
    const s = storage();
    expect(await designPreviews(s, [file("p", "application/pdf"), file("v", "video/mp4")])).toMatchObject([
      { id: "p", url: null },
      { id: "v", url: null },
    ]);
    expect(s.signedUrl).not.toHaveBeenCalled();
  });

  it("no Storage, or a link that fails: shown by name, and the failure is logged", async () => {
    expect(await designPreviews(null, [file("a", "image/png")])).toMatchObject([{ id: "a", url: null }]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = storage(vi.fn(async () => Promise.reject(new Error("Storage sign failed (500)"))));
    expect(await designPreviews(failing, [file("a", "image/png")])).toMatchObject([{ id: "a", url: null }]);
    expect(error).toHaveBeenCalledWith("Making a design preview link failed:", expect.any(Error));
  });

  it("a slow Storage never holds up the result: links not ready by the deadline are left out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const slow = storage(vi.fn((path: string) => new Promise<string>((resolve) => setTimeout(() => resolve(`late/${path}`), 200))));
    const started = Date.now();
    expect(await designPreviews(slow, [file("a", "image/png")], 20)).toMatchObject([{ id: "a", url: null }]);
    expect(Date.now() - started).toBeLessThan(150);
  });
});
