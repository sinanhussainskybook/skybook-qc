"use client";

import { useActionState, useState } from "react";
import { ExternalLink } from "lucide-react";
import { setPlatformAction, type QcFormState } from "@/lib/qc/actions";
import type { ContentMedia } from "@/lib/qc/content-types";
import { findPlacement, findPlatform, placementsFor, platformsFor } from "@/lib/qc/platforms";
import { placementSummary } from "@/lib/qc/platform-summary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { submitKeepingValues } from "@/components/qc/submit-keeping-values";

const BOX =
  "w-full rounded-xl border border-input bg-card px-3.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export type PlatformFormValues = {
  platform: string | null;
  placement: string | null;
  customLabel: string | null;
  customWidth: number | null;
  customHeight: number | null;
  customUnit: "px" | "mm" | null;
  customMinDpi: number | null;
  customMaxBytes: number | null;
};

/**
 * Platform, then placement (Phase 5, D4). Platforms with a published spec
 * offer their placements; the others (banners, print, slides, other) ask
 * for the required size instead.
 */
export function PlatformForm({
  sessionId,
  media,
  current,
}: {
  sessionId: string;
  media: ContentMedia;
  current: PlatformFormValues;
}) {
  const [platformKey, setPlatformKey] = useState(current.platform ?? "");
  const [placementKey, setPlacementKey] = useState(current.placement ?? "");
  const [unit, setUnit] = useState<string>(current.customUnit ?? "");
  const [state, formAction, pending] = useActionState<QcFormState, FormData>(setPlatformAction, {});

  const platform = findPlatform(platformKey);
  const placements = platform ? placementsFor(platform, media) : [];
  const spec = findPlacement(platform, placementKey);
  const custom = platform?.custom;
  const effectiveUnit = custom?.units.length === 1 ? custom.units[0] : unit;

  return (
    <form onSubmit={submitKeepingValues(formAction)} className="space-y-4">
      <input type="hidden" name="sessionId" value={sessionId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="qc-platform" className="mb-2 block text-sm font-medium">
            Platform
          </label>
          <select
            id="qc-platform"
            name="platform"
            value={platformKey}
            onChange={(e) => {
              setPlatformKey(e.target.value);
              setPlacementKey("");
            }}
            className={cn(BOX, "h-10")}
          >
            <option value="" disabled>
              Choose…
            </option>
            {platformsFor(media).map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        {platform?.placements && (
          <div>
            <label htmlFor="qc-placement" className="mb-2 block text-sm font-medium">
              Placement
            </label>
            <select
              id="qc-placement"
              name="placement"
              value={placementKey}
              onChange={(e) => setPlacementKey(e.target.value)}
              className={cn(BOX, "h-10")}
            >
              <option value="" disabled>
                Choose…
              </option>
              {placements.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {custom?.needsLabel && (
          <div className="sm:col-span-2">
            <label htmlFor="qc-custom-label" className="mb-2 block text-sm font-medium">
              Where will it be used? <span className="text-muted-foreground">(required)</span>
            </label>
            <Input
              id="qc-custom-label"
              name="customLabel"
              maxLength={120}
              defaultValue={current.customLabel ?? ""}
              placeholder="e.g. Airport digital screen"
              className="h-10 rounded-xl bg-card px-3.5"
            />
          </div>
        )}

        {custom && (
          <>
            <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2 sm:col-span-2 sm:max-w-md">
              <div>
                <label htmlFor="qc-custom-width" className="mb-2 block text-sm font-medium">
                  Required width
                </label>
                <Input
                  id="qc-custom-width"
                  name="customWidth"
                  inputMode="numeric"
                  defaultValue={current.customWidth ?? ""}
                  className="h-10 rounded-xl bg-card px-3.5"
                />
              </div>
              <span className="pb-2.5 text-muted-foreground">×</span>
              <div>
                <label htmlFor="qc-custom-height" className="mb-2 block text-sm font-medium">
                  Required height
                </label>
                <Input
                  id="qc-custom-height"
                  name="customHeight"
                  inputMode="numeric"
                  defaultValue={current.customHeight ?? ""}
                  className="h-10 rounded-xl bg-card px-3.5"
                />
              </div>
            </div>
            {custom.units.length > 1 ? (
              <div>
                <label htmlFor="qc-custom-unit" className="mb-2 block text-sm font-medium">
                  Unit
                </label>
                <select
                  id="qc-custom-unit"
                  name="customUnit"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  className={cn(BOX, "h-10")}
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="px">Pixels (px)</option>
                  <option value="mm">Millimetres (mm) — print</option>
                </select>
              </div>
            ) : (
              <input type="hidden" name="customUnit" value={custom.units[0]} />
            )}
            {custom.dpi && effectiveUnit === "mm" && (
              <div>
                <label htmlFor="qc-custom-dpi" className="mb-2 block text-sm font-medium">
                  Minimum DPI <span className="text-muted-foreground">(optional)</span>
                </label>
                <Input
                  id="qc-custom-dpi"
                  name="customMinDpi"
                  inputMode="numeric"
                  defaultValue={current.customMinDpi ?? ""}
                  placeholder="e.g. 300"
                  className="h-10 rounded-xl bg-card px-3.5"
                />
              </div>
            )}
            <div>
              <label htmlFor="qc-custom-maxmb" className="mb-2 block text-sm font-medium">
                Maximum file size in MB <span className="text-muted-foreground">(optional)</span>
              </label>
              <Input
                id="qc-custom-maxmb"
                name="customMaxMb"
                inputMode="decimal"
                defaultValue={current.customMaxBytes ? String(current.customMaxBytes / 1_000_000) : ""}
                placeholder="e.g. 1"
                className="h-10 rounded-xl bg-card px-3.5"
              />
            </div>
          </>
        )}
      </div>

      {custom && (
        <p className="text-xs text-muted-foreground">
          {platform!.label} has no single official size, so enter the size you were given. It is checked exactly as typed.
        </p>
      )}

      {spec && (
        <div className="rounded-xl bg-muted/60 p-4 text-sm ring-1 ring-border">
          <p className="mb-2 font-medium">What will be checked</p>
          <ul className="space-y-1 text-muted-foreground">
            {placementSummary(spec).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <a
            href={spec.source.url}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            Source: {spec.source.label}
            <ExternalLink className="size-3" aria-hidden />
          </a>
        </div>
      )}

      {state.error && (
        <p role="alert" className="text-sm font-medium text-fail">
          {state.error}
        </p>
      )}
      {state.ok && state.message && <p className="text-sm font-medium text-pass">{state.message}</p>}

      <Button
        type="submit"
        disabled={!platform || (Boolean(platform.placements) && !spec) || pending}
        className="btn-glossy h-10 rounded-full bg-foreground px-5 text-sm font-semibold text-background hover:bg-foreground/85"
      >
        {pending ? "Saving…" : "Save platform"}
      </Button>
    </form>
  );
}
