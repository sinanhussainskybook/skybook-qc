import { describe, expect, it } from "vitest";
import { CONTENT_TYPES, contentMedia, isContentType } from "@/lib/qc/content-types";
import {
  acceptList,
  allowedFormats,
  checkFormatBytes,
  checkUploadedFile,
  checkUploadRequest,
  maxFiles,
  QC_FILE_MESSAGES,
  VIDEO_MAX_BYTES,
} from "@/lib/qc/qc-file";
import {
  DOCM, DOCX, EXE, GIF, HTML, JPEG, MKV, MOV, MP4, OLD_MOV, OLE, PDF, PLAIN_ZIP, PNG, TXT, WEBM, WEBP, XLSX,
} from "../../../test/logo-files";

const MB = 1024 * 1024;
const LIMIT = 25 * MB;
const req = (name: string, type = "", size = 1000) => ({ name, type, size });

describe("content types", () => {
  it("has exactly the four types, sharing one model", () => {
    expect(CONTENT_TYPES.map((t) => t.label)).toEqual([
      "Design / Poster",
      "Social Media Post",
      "Reel / Short",
      "YouTube Video",
    ]);
    expect(isContentType("design_poster")).toBe(true);
    expect(isContentType("podcast")).toBe(false);
    expect(contentMedia("reel_short")).toBe("video");
    expect(contentMedia("social_post")).toBe("visual");
  });
});

describe("which files each area accepts", () => {
  it("Upload Information: documents, spreadsheets, text and images — whatever the content type", () => {
    for (const type of CONTENT_TYPES) {
      expect(allowedFormats("information", type.value)).toEqual([
        "pdf", "doc", "docx", "xls", "xlsx", "txt", "jpeg", "png", "webp",
      ]);
    }
  });

  it("Upload Content follows the content type", () => {
    expect(allowedFormats("content", "design_poster")).toEqual(["jpeg", "png", "webp", "pdf"]);
    expect(allowedFormats("content", "social_post")).toEqual(["jpeg", "png", "webp", "pdf"]);
    expect(allowedFormats("content", "reel_short")).toEqual(["mp4", "mov", "webm"]);
    expect(allowedFormats("content", "youtube_video")).toEqual(["mp4", "mov", "webm"]);
    expect(acceptList("content", "reel_short")).toBe(".mp4,video/mp4,.mov,video/quicktime,.webm,video/webm");
  });

  it("allows up to 10 information files and 10 images, but one video", () => {
    expect(maxFiles("information", "reel_short")).toBe(10);
    expect(maxFiles("content", "social_post")).toBe(10);
    expect(maxFiles("content", "youtube_video")).toBe(1);
  });
});

describe("before upload: name, type and size", () => {
  it("accepts each allowed type with a matching name", () => {
    for (const name of ["brief.pdf", "brief.doc", "brief.docx", "sheet.xls", "sheet.xlsx", "notes.txt", "ref.jpg", "ref.JPEG", "ref.png", "ref.webp"]) {
      expect(checkUploadRequest(req(name), "information", "design_poster", LIMIT).ok, name).toBe(true);
    }
    for (const name of ["reel.mp4", "reel.MOV", "reel.webm"]) {
      expect(checkUploadRequest(req(name), "content", "reel_short", LIMIT).ok, name).toBe(true);
    }
  });

  it("rejects types the area doesn't accept, and anything executable or web", () => {
    for (const name of ["setup.exe", "page.html", "script.js", "logo.svg", "anim.gif", "archive.zip", "macro.docm", "sheet.xlsm", "noextension", "photo.png.exe"]) {
      expect(checkUploadRequest(req(name), "information", "design_poster", LIMIT), name).toMatchObject({ ok: false });
    }
  });

  it("rejects content that doesn't fit the content type (image for a Reel, video for a Poster)", () => {
    expect(checkUploadRequest(req("poster.png", "image/png"), "content", "reel_short", LIMIT)).toEqual({
      ok: false,
      error: "This area accepts MP4, MOV, WEBM files.",
    });
    expect(checkUploadRequest(req("clip.mp4", "video/mp4"), "content", "design_poster", LIMIT)).toMatchObject({ ok: false });
  });

  it("rejects a declared type that disagrees with the name", () => {
    expect(checkUploadRequest(req("brief.pdf", "text/html"), "information", "design_poster", LIMIT)).toEqual({
      ok: false,
      error: QC_FILE_MESSAGES.mismatch,
    });
    expect(checkUploadRequest(req("brief.pdf", "application/pdf"), "information", "design_poster", LIMIT).ok).toBe(true);
    expect(checkUploadRequest(req("brief.pdf", "application/octet-stream"), "information", "design_poster", LIMIT).ok).toBe(true);
  });

  it("enforces 25 MB for files and 50 MB for video, and rejects empty files", () => {
    expect(checkUploadRequest(req("a.png", "", LIMIT), "content", "design_poster", LIMIT).ok).toBe(true);
    expect(checkUploadRequest(req("a.png", "", LIMIT + 1), "content", "design_poster", LIMIT)).toMatchObject({ ok: false, error: /25 MB|25.0 MB/ });
    expect(checkUploadRequest(req("a.mp4", "", VIDEO_MAX_BYTES), "content", "reel_short", LIMIT).ok).toBe(true);
    expect(checkUploadRequest(req("a.mp4", "", VIDEO_MAX_BYTES + 1), "content", "reel_short", LIMIT)).toMatchObject({ ok: false, error: /50/ });
    expect(checkUploadRequest(req("a.png", "", 0), "content", "design_poster", LIMIT)).toEqual({ ok: false, error: QC_FILE_MESSAGES.empty });
  });

  it("cleans unsafe names for display and never uses them as paths", () => {
    const result = checkUploadRequest(req("..\\..\\windows\\sys\u0000tem\\brief.pdf"), "information", "design_poster", LIMIT);
    expect(result).toMatchObject({ ok: true, value: { fileName: "brief.pdf", ext: "pdf" } });
    const jpeg = checkUploadRequest(req("photo.JPEG"), "information", "design_poster", LIMIT);
    expect(jpeg).toMatchObject({ ok: true, value: { ext: "jpg", mime: "image/jpeg" } });
  });
});

describe("after upload: what actually arrived", () => {
  it("recognises every format from its first bytes", () => {
    const cases: [Parameters<typeof checkFormatBytes>[0], Uint8Array][] = [
      ["pdf", PDF], ["docx", DOCX], ["xlsx", XLSX], ["doc", OLE], ["xls", OLE], ["txt", TXT],
      ["jpeg", JPEG], ["png", PNG], ["webp", WEBP], ["mp4", MP4], ["mov", MOV], ["mov", OLD_MOV], ["mp4", MOV], ["webm", WEBM],
    ];
    for (const [format, bytes] of cases) expect(checkFormatBytes(format, bytes), format).toBeNull();
  });

  it("rejects files renamed to look like something else", () => {
    const cases: [Parameters<typeof checkFormatBytes>[0], Uint8Array][] = [
      ["pdf", HTML], ["pdf", PNG], ["docx", XLSX], ["xlsx", DOCX], ["docx", PLAIN_ZIP], ["doc", DOCX],
      ["txt", EXE], ["txt", PNG], ["txt", DOCX], ["jpeg", PNG], ["png", GIF], ["mp4", WEBM], ["webm", MKV], ["png", EXE],
    ];
    for (const [format, bytes] of cases) {
      expect(checkFormatBytes(format, bytes), `${format} ← wrong bytes`).toBe(QC_FILE_MESSAGES.mismatch);
    }
  });

  it("refuses macro-enabled Office files", () => {
    expect(checkFormatBytes("docx", DOCM)).toBe(QC_FILE_MESSAGES.macros);
  });

  it("uses the REAL stored size, not the size the browser claimed", () => {
    expect(checkUploadedFile({ format: "png", maxBytes: LIMIT }, { bytes: PNG, totalSize: LIMIT + 1 })).toMatch(/too large/);
    expect(checkUploadedFile({ format: "png", maxBytes: LIMIT }, { bytes: new Uint8Array(), totalSize: 0 })).toBe(QC_FILE_MESSAGES.empty);
    expect(checkUploadedFile({ format: "png", maxBytes: LIMIT }, { bytes: PNG, totalSize: 5000 })).toBeNull();
  });
});
