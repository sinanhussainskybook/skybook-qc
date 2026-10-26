// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/** The design uploader's Replace and Dismiss: the original is only removed once its replacement is confirmed. */

const actions = vi.hoisted(() => ({
  prepareUploadAction: vi.fn(),
  confirmUploadAction: vi.fn(),
  cancelUploadAction: vi.fn(),
  removeFileAction: vi.fn(),
}));
vi.mock("@/lib/qc/actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const { FileUploader } = await import("@/components/qc/file-uploader");

const SESSION = "5b6d0f0e-8c1a-4a57-9a4e-2a6f1d6c9e02";
const OLD = { id: "0b6d0f0e-8c1a-4a57-9a4e-2a6f1d6c9e01", file_name: "poster-v1.png", mime_type: "image/png", file_size: 1000 };

/** The browser's PUT to Storage: succeeds or fails. */
let putSucceeds = true;
class FakeXhr {
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 200;
  open() {}
  setRequestHeader() {}
  send() {
    queueMicrotask(() => (putSucceeds ? this.onload?.() : this.onerror?.()));
  }
}

function renderUploader() {
  return render(
    <FileUploader sessionId={SESSION} kind="content" contentType="design_poster" files={[OLD]} maxFiles={10} generalLimitBytes={25 * 1024 * 1024} storageReady buttonLabel="Upload design" />
  );
}
const pngFile = (name = "poster-v2.png") => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
async function replaceWith(file: File) {
  const input = screen.getByLabelText(`Replace ${OLD.file_name}`).querySelector("input")!;
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  // Let the upload's steps (prepare → PUT → confirm → remove) run.
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  putSucceeds = true;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  actions.prepareUploadAction.mockReset().mockResolvedValue({ ok: true, fileId: "new-file", uploadUrl: "https://storage.test/put", contentType: "image/png" });
  actions.confirmUploadAction.mockReset().mockResolvedValue({ ok: true });
  actions.cancelUploadAction.mockReset().mockResolvedValue(undefined);
  actions.removeFileAction.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Replace a design", () => {
  it("uploads and confirms the new file first, then removes the old one", async () => {
    renderUploader();
    await replaceWith(pngFile());
    expect(actions.prepareUploadAction).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION, kind: "content", name: "poster-v2.png", replacing: OLD.id }));
    expect(actions.confirmUploadAction).toHaveBeenCalledWith({ sessionId: SESSION, fileId: "new-file" });
    expect(actions.removeFileAction).toHaveBeenCalledOnce();
    const form = actions.removeFileAction.mock.calls[0][1] as FormData;
    expect([form.get("sessionId"), form.get("fileId")]).toEqual([SESSION, OLD.id]);
    // Removed only after the new file was confirmed.
    expect(actions.confirmUploadAction.mock.invocationCallOrder[0]).toBeLessThan(actions.removeFileAction.mock.invocationCallOrder[0]);
  });

  it("never removes the original when the new upload fails — at any step", async () => {
    renderUploader();
    // Refused before upload.
    actions.prepareUploadAction.mockResolvedValueOnce({ ok: false, error: "That file is too large." });
    await replaceWith(pngFile());
    // The upload to Storage didn't finish.
    putSucceeds = false;
    await replaceWith(pngFile());
    putSucceeds = true;
    // The file arrived but failed the server's check.
    actions.confirmUploadAction.mockResolvedValueOnce({ ok: false, error: "The file's name or type doesn't match what's inside it." });
    await replaceWith(pngFile());
    // Each attempt really ran to the step where it failed…
    expect(actions.prepareUploadAction).toHaveBeenCalledTimes(3);
    expect(actions.cancelUploadAction).toHaveBeenCalledOnce(); // the unfinished upload is cleaned up
    expect(actions.confirmUploadAction).toHaveBeenCalledOnce();
    // …and the original was never touched.
    expect(actions.removeFileAction).not.toHaveBeenCalled();
    expect(screen.getByText(/doesn't match what's inside it/)).toBeTruthy();
  });

  it("says so if the old file couldn't be removed after the new one was added", async () => {
    actions.removeFileAction.mockResolvedValueOnce({ error: "Storage didn't answer" });
    renderUploader();
    await replaceWith(pngFile());
    expect(screen.getByRole("alert").textContent).toBe(
      "The new file was added, but poster-v1.png couldn't be removed (Storage didn't answer). Remove it before checking again."
    );
  });

  it("is offered for designs only, never for the brief", () => {
    render(<FileUploader sessionId={SESSION} kind="information" contentType="design_poster" files={[{ ...OLD, file_name: "brief.pdf", mime_type: "application/pdf" }]} maxFiles={10} generalLimitBytes={1000} storageReady buttonLabel="Upload brief" />);
    expect(screen.queryByLabelText(/^Replace /)).toBeNull();
  });
});

describe("Dismiss a failed upload", () => {
  it("a failed upload can be dismissed; it no longer stays on the page", async () => {
    actions.prepareUploadAction.mockResolvedValueOnce({ ok: false, error: "That file is too large. The limit here is 25 MB." });
    renderUploader();
    await replaceWith(pngFile("huge.png"));
    expect(screen.getByText("Not uploaded")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Dismiss huge.png (replacing poster-v1.png)"));
    });
    expect(screen.queryByText("Not uploaded")).toBeNull();
    expect(screen.queryByText(/too large/)).toBeNull();
  });
});
