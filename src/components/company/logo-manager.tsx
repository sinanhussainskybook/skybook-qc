"use client";

import { useActionState, useState } from "react";
import Image from "next/image";
import { ImageOff, ImageUp, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { removeLogoAction, uploadLogoAction, type LogoFormState } from "@/lib/company/logo-actions";
import {
  formatBytes,
  kindLabel,
  LOGO_ACCEPT,
  precheckLogoFile,
} from "@/lib/company/logo-file";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The company's one logo (D3): see it, upload one, replace it, remove it.
 * The browser only does quick checks for fast feedback; the server checks
 * the file again and decides where it is stored.
 */

export type LogoView = { file_name: string; mime_type: string; file_size: number };

const UNEXPECTED = "The upload didn't go through. Check the file is at most 2 MB and try again.";

export function LogoManager({
  companyId,
  logo,
  imageUrl,
  storageReady,
}: {
  companyId: string;
  logo: LogoView | null;
  imageUrl: string | null;
  storageReady: boolean;
}) {
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState<{ name: string; size: number } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // Which action's result to show (null = none, e.g. after starting a new attempt).
  const [last, setLast] = useState<"upload" | "remove" | null>(null);

  const [uploadState, uploadAction, uploading] = useActionState<LogoFormState, FormData>(
    async (previous, formData) => {
      setLast("upload");
      // React clears the form's file input after every submit, so the
      // chosen file is forgotten either way — success or failure.
      setChosen(null);
      try {
        const result = await uploadLogoAction(previous, formData);
        if (result.ok) setChoosing(false);
        return result;
      } catch {
        // e.g. the request was refused for size before reaching the check
        return { error: UNEXPECTED };
      }
    },
    {}
  );
  const [removeState, removeAction, removing] = useActionState<LogoFormState, FormData>(
    async (previous, formData) => {
      setLast("remove");
      try {
        const result = await removeLogoAction(previous, formData);
        setConfirmingRemove(false);
        return result;
      } catch {
        return { error: "The logo couldn't be removed. Please try again." };
      }
    },
    {}
  );

  const result = last === "upload" ? uploadState : last === "remove" ? removeState : {};
  const status = localError ?? result.error;
  const success = status ? undefined : result.message;
  const busy = uploading || removing;

  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
      <div
        className="logo-preview relative flex aspect-[4/3] w-full shrink-0 items-center justify-center overflow-hidden rounded-xl ring-1 ring-border sm:w-56"
        data-testid="logo-preview"
      >
        {logo && imageUrl ? (
          <Image
            src={imageUrl}
            alt={`Current logo: ${logo.file_name}`}
            fill
            unoptimized
            sizes="224px"
            className="object-contain p-4"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 px-4 text-center text-sm text-muted-foreground">
            <ImageOff className="size-6" aria-hidden />
            {logo ? "The logo can't be shown right now." : "No logo yet"}
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-4">
        {logo ? (
          <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">File</dt>
            <dd className="min-w-0 font-medium break-all">{logo.file_name}</dd>
            <dt className="text-muted-foreground">Type</dt>
            <dd>{kindLabel(logo.mime_type)}</dd>
            <dt className="text-muted-foreground">Size</dt>
            <dd>{formatBytes(logo.file_size)}</dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            Upload the company&apos;s current logo. QC will compare designs against it.
          </p>
        )}

        {!storageReady && (
          <p className="flex items-start gap-2 rounded-xl bg-revision-soft px-3.5 py-2.5 text-sm text-revision">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            Logo storage isn&apos;t set up on this server yet, so logos can&apos;t be uploaded or
            removed. Ask your administrator.
          </p>
        )}

        {choosing ? (
          <form
            action={uploadAction}
            className="space-y-3 rounded-xl bg-muted/60 p-4 ring-1 ring-border"
            aria-label={logo ? "Replace logo" : "Upload logo"}
          >
            <input type="hidden" name="companyId" value={companyId} />
            <label
              className={cn(
                buttonVariants({ variant: "outline" }),
                "h-9 cursor-pointer rounded-full px-4 focus-within:ring-3 focus-within:ring-ring/50"
              )}
            >
              <ImageUp aria-hidden />
              {chosen ? "Choose a different file" : "Choose file"}
              <input
                type="file"
                name="logo"
                accept={LOGO_ACCEPT}
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) {
                    setChosen(null);
                    return;
                  }
                  const problem = precheckLogoFile(file);
                  setLocalError(problem);
                  if (problem) {
                    event.target.value = "";
                    setChosen(null);
                  } else {
                    setChosen({ name: file.name, size: file.size });
                  }
                }}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              {chosen
                ? `${chosen.name} · ${formatBytes(chosen.size)}`
                : "PNG, JPG, WEBP or SVG, up to 2 MB."}
            </p>
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={!chosen || busy}
                className="h-9 rounded-full px-4"
              >
                {uploading ? "Uploading…" : logo ? "Replace logo" : "Upload logo"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-9 rounded-full px-4"
                disabled={uploading}
                onClick={() => {
                  setChoosing(false);
                  setChosen(null);
                  setLocalError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              disabled={!storageReady || busy}
              className="h-9 rounded-full bg-foreground px-4 text-background hover:bg-foreground/85"
              onClick={() => {
                setLocalError(null);
                setLast(null);
                setConfirmingRemove(false);
                setChoosing(true);
              }}
            >
              {logo ? <RefreshCw aria-hidden /> : <ImageUp aria-hidden />}
              {logo ? "Replace logo" : "Upload logo"}
            </Button>

            {logo &&
              (confirmingRemove ? (
                <form
                  action={removeAction}
                  className="flex flex-wrap items-center gap-1 rounded-full bg-fail-soft py-0.5 pr-0.5 pl-3"
                >
                  <input type="hidden" name="companyId" value={companyId} />
                  <span className="text-xs font-medium text-fail">Remove the logo?</span>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={busy}
                    className="rounded-full bg-fail text-white hover:bg-fail/85"
                  >
                    {removing ? "Removing…" : "Yes, remove"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="rounded-full"
                    onClick={() => setConfirmingRemove(false)}
                  >
                    Cancel
                  </Button>
                </form>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={!storageReady || busy}
                  className="h-9 rounded-full px-4 text-fail hover:bg-fail-soft hover:text-fail"
                  onClick={() => {
                    setLocalError(null);
                    setLast(null);
                    setConfirmingRemove(true);
                  }}
                >
                  <Trash2 aria-hidden />
                  Remove
                </Button>
              ))}
          </div>
        )}

        <p
          role={status ? "alert" : "status"}
          className={cn(
            "text-sm font-medium",
            status ? "text-fail" : "text-pass",
            !status && !success && "sr-only"
          )}
        >
          {status ?? success}
        </p>
      </div>
    </div>
  );
}
