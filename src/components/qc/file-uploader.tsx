"use client";

import { useActionState, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Film, Image as ImageIcon, RefreshCw, Upload, X } from "lucide-react";
import {
  cancelUploadAction,
  confirmUploadAction,
  prepareUploadAction,
  removeFileAction,
} from "@/lib/qc/actions";
import { formatBytes } from "@/lib/company/logo-file";
import type { ContentType } from "@/lib/qc/content-types";
import { acceptList, checkUploadRequest, formatLabelForMime, formatsLabel, type FileKind } from "@/lib/qc/qc-file";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Upload Information / Upload Content. Each file goes:
 *   quick check here → server checks the request and hands out a one-time
 *   upload link for a path it chose → the file goes straight to Supabase
 *   Storage → server checks what actually arrived (a bad file is deleted).
 *
 * Replace (designs): the new file goes through the same steps first; the old
 * one is removed only once the new one is confirmed, so a failed replacement
 * never loses the original.
 */

export type FileView = { id: string; file_name: string; mime_type: string; file_size: number };

type Upload = {
  key: string;
  name: string;
  step: "sending" | "checking" | "failed";
  progress: number;
  error?: string;
};

function putFile(url: string, file: File, contentType: string, onProgress: (p: number) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.onabort = () => resolve(false);
    xhr.send(file);
  });
}

function iconFor(mime: string) {
  if (mime.startsWith("video/")) return Film;
  if (mime.startsWith("image/")) return ImageIcon;
  return FileText;
}

export function FileUploader({
  sessionId,
  kind,
  contentType,
  files,
  maxFiles,
  generalLimitBytes,
  storageReady,
  buttonLabel,
}: {
  sessionId: string;
  kind: FileKind;
  contentType: ContentType;
  files: FileView[];
  maxFiles: number;
  generalLimitBytes: number;
  storageReady: boolean;
  buttonLabel: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [removeState, removeAction, removing] = useActionState(removeFileAction, {});
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const replaceCount = useRef(0);
  const busy = uploads.some((u) => u.step !== "failed");
  const full = files.length >= maxFiles;

  const update = (key: string, change: Partial<Upload>) =>
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...change } : u)));

  /** Uploads one file; true once the server has confirmed it. */
  async function uploadOne(file: File, key: string, replacing?: string): Promise<boolean> {
    const fail = (error: string) => {
      update(key, { step: "failed", error });
      return false;
    };

    const quick = checkUploadRequest(file, kind, contentType, generalLimitBytes);
    if (!quick.ok) return fail(quick.error);

    const prepared = await prepareUploadAction({ sessionId, kind, name: file.name, size: file.size, type: file.type, replacing }).catch(
      () => ({ ok: false as const, error: "The upload couldn't start. Please try again." })
    );
    if (!prepared.ok) return fail(prepared.error);

    const sent = await putFile(prepared.uploadUrl, file, prepared.contentType, (progress) => update(key, { progress }));
    if (!sent) {
      await cancelUploadAction({ sessionId, fileId: prepared.fileId }).catch(() => {});
      return fail("The upload didn't finish. Check your connection and try again.");
    }

    update(key, { step: "checking", progress: 100 });
    const confirmed = await confirmUploadAction({ sessionId, fileId: prepared.fileId }).catch(() => ({
      ok: false,
      error: "The file couldn't be checked. Please try again.",
    }));
    if (!confirmed.ok) return fail(confirmed.error ?? "The file couldn't be checked.");
    setUploads((list) => list.filter((u) => u.key !== key));
    return true;
  }

  /** Replace: upload and confirm the new file first, then remove the old one — never the other way round. */
  async function onReplace(old: FileView, list: FileList | null) {
    const file = list?.[0];
    if (!file) return;
    const key = `replace-${++replaceCount.current}-${file.name}`;
    setReplaceError(null);
    setUploads((current) => [
      ...current.filter((u) => u.step !== "failed"),
      { key, name: `${file.name} (replacing ${old.file_name})`, step: "sending", progress: 0 },
    ]);
    if (await uploadOne(file, key, old.id)) {
      const form = new FormData();
      form.set("sessionId", sessionId);
      form.set("fileId", old.id);
      const removed = await removeFileAction({}, form).catch(() => ({ error: "it couldn't be reached" }));
      if (removed.error) {
        setReplaceError(`The new file was added, but ${old.file_name} couldn't be removed (${removed.error}). Remove it before checking again.`);
      }
    }
    router.refresh();
  }

  const dismiss = (key: string) => setUploads((list) => list.filter((u) => u.key !== key));

  async function onPick(list: FileList | null) {
    if (!list || list.length === 0) return;
    const picked = Array.from(list).slice(0, Math.max(0, maxFiles - files.length));
    const batch = picked.map((file, i) => ({
      file,
      key: `${Date.now()}-${i}-${file.name}`,
    }));
    setUploads((current) => [
      ...current.filter((u) => u.step !== "failed"),
      ...batch.map(({ file, key }) => ({ key, name: file.name, step: "sending" as const, progress: 0 })),
    ]);
    if (input.current) input.current.value = "";
    for (const { file, key } of batch) await uploadOne(file, key); // one at a time
    router.refresh();
  }

  const inputId = `upload-${kind}`;
  return (
    <div className="space-y-3">
      {files.length > 0 && (
        <ul className="@container space-y-2">
          {files.map((file) => {
            const Icon = iconFor(file.mime_type);
            return (
              <li key={file.id} className="flex items-center gap-3 rounded-xl border border-border p-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{file.file_name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {formatLabelForMime(file.mime_type)} · {formatBytes(file.file_size)}
                  </span>
                </span>
                {kind === "content" && (
                  <label
                    className={cn(
                      buttonVariants({ variant: "ghost", size: "sm" }),
                      "cursor-pointer rounded-full hover:text-primary focus-within:ring-3 focus-within:ring-ring/50",
                      (!storageReady || removing || busy) && "pointer-events-none opacity-50"
                    )}
                    aria-label={`Replace ${file.file_name}`}
                  >
                    <RefreshCw aria-hidden />
                    <span className="hidden @sm:inline">Replace</span>
                    <input
                      type="file"
                      accept={acceptList(kind, contentType)}
                      disabled={!storageReady || removing || busy}
                      onChange={(event) => {
                        const picked = event.target.files;
                        void onReplace(file, picked);
                        event.target.value = "";
                      }}
                      className="sr-only"
                    />
                  </label>
                )}
                <form action={removeAction}>
                  <input type="hidden" name="sessionId" value={sessionId} />
                  <input type="hidden" name="fileId" value={file.id} />
                  <Button
                    type="submit"
                    variant="ghost"
                    size="sm"
                    disabled={removing || busy}
                    className="rounded-full text-fail hover:bg-fail-soft hover:text-fail"
                    aria-label={`Remove ${file.file_name}`}
                  >
                    <X aria-hidden />
                    {/* Just the ✕ in a narrow column (the side pane next to the result), so the file name has room. */}
                    <span className="hidden @sm:inline">Remove</span>
                  </Button>
                </form>
              </li>
            );
          })}
        </ul>
      )}

      {uploads.length > 0 && (
        <ul className="space-y-2" aria-live="polite">
          {uploads.map((upload) => (
            <li
              key={upload.key}
              className={cn(
                "rounded-xl p-3 text-sm ring-1",
                upload.step === "failed" ? "bg-fail-soft ring-fail/30" : "bg-muted/60 ring-border"
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{upload.name}</span>
                <span className="flex shrink-0 items-center gap-1">
                  <span className={cn("text-xs", upload.step === "failed" ? "text-fail" : "text-muted-foreground")}>
                    {upload.step === "sending" ? `Uploading ${upload.progress}%` : upload.step === "checking" ? "Checking…" : "Not uploaded"}
                  </span>
                  {upload.step === "failed" && (
                    <Button type="button" variant="ghost" size="icon-xs" className="rounded-full" onClick={() => dismiss(upload.key)} aria-label={`Dismiss ${upload.name}`}>
                      <X aria-hidden />
                    </Button>
                  )}
                </span>
              </div>
              {upload.step === "sending" && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
                  <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${upload.progress}%` }} />
                </div>
              )}
              {upload.error && <p className="mt-1 text-sm text-fail">{upload.error}</p>}
            </li>
          ))}
        </ul>
      )}

      {replaceError && (
        <p role="alert" className="text-sm font-medium text-fail">
          {replaceError}
        </p>
      )}

      {removeState.error && (
        <p role="alert" className="text-sm font-medium text-fail">
          {removeState.error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label
          htmlFor={inputId}
          className={cn(
            buttonVariants({ variant: "outline" }),
            "btn-white h-11 cursor-pointer rounded-full px-5 text-sm font-semibold hover:border-primary/40 hover:text-primary focus-within:ring-3 focus-within:ring-ring/50",
            (!storageReady || busy || full) && "pointer-events-none opacity-50"
          )}
        >
          <Upload aria-hidden />
          {buttonLabel}
          <input
            ref={input}
            id={inputId}
            type="file"
            name={kind}
            multiple={maxFiles > 1}
            accept={acceptList(kind, contentType)}
            disabled={!storageReady || busy || full}
            onChange={(event) => onPick(event.target.files)}
            className="sr-only"
          />
        </label>
        <span className="text-xs text-muted-foreground">
          {full
            ? `Limit reached (${maxFiles} file${maxFiles === 1 ? "" : "s"}). Remove one to add another.`
            : `${formatsLabel(kind, contentType)} · up to ${maxFiles} file${maxFiles === 1 ? "" : "s"}`}
        </span>
      </div>
    </div>
  );
}
