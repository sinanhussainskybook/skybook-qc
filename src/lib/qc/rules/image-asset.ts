import type { ContentDetections } from "@/lib/qc/detections";
import type { Finding, Rule, Severity } from "@/lib/qc/findings";
import { ALL_TYPES, findingFor, NEEDS_ANALYSIS, notVerified, VIDEO_TYPES, type QcContext } from "@/lib/qc/rules/context";

/**
 * Image & Asset QC (plan 5.9): quality problems in the pictures and footage
 * — a stock watermark, blur, pixelation, stretching, something important cut
 * off. For video, the sound (5.14): no audio, clipping, too quiet / loud.
 * (The file's own size, format and resolution are Platform / Size, 5.11.)
 */

const CATEGORY = "image_asset" as const;

type Issue = NonNullable<ContentDetections["imageIssues"]>[number]["issue"];
const ISSUES: Record<Issue, { title: string; severity: Severity; explanation: string; fix: string }> = {
  watermark: {
    title: "Stock watermark",
    severity: "critical",
    explanation: "An image still carries a stock-photo watermark — it hasn't been licensed, or the preview was used by mistake.",
    fix: "Replace it with the licensed, unwatermarked image.",
  },
  blurry: { title: "Blurry image", severity: "major", explanation: "An image is out of focus or soft.", fix: "Use a sharper original." },
  pixelated: { title: "Pixelated image", severity: "major", explanation: "An image has been enlarged beyond its resolution and looks blocky.", fix: "Use a higher-resolution original." },
  stretched: { title: "Stretched image", severity: "major", explanation: "An image (or the logo) is stretched or squashed out of its proportions.", fix: "Resize it keeping its proportions." },
  cut_off: { title: "Cut off", severity: "minor", explanation: "Something important is cut off at the edge of the frame.", fix: "Reposition or recrop so it's fully in view." },
};

const qualityRule: Rule<QcContext> = {
  id: "image.quality",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["image analysis"],
  defaultSeverity: "major",
  mandatory: false,
  run(context) {
    const issues = context.detections?.imageIssues;
    if (!issues) return [notVerified(this.id, CATEGORY, "Image quality", "major", NEEDS_ANALYSIS)];
    if (issues.length === 0) {
      return [findingFor(this.id, CATEGORY, "Image quality")({ severity: "major", status: "passed", detected: "No problems found", explanation: "No watermark, blur, pixelation, stretching or cut-off found." })];
    }
    const names = new Map(context.platform.files.map((f) => [f.id, f.fileName]));
    return issues.map((i) => {
      const spec = ISSUES[i.issue];
      return findingFor(`${this.id}.${i.issue}`, CATEGORY, spec.title)({
        severity: spec.severity,
        status: "failed",
        expected: "Clean, sharp, correctly proportioned images",
        detected: i.note ?? spec.title,
        explanation: spec.explanation,
        suggestedFix: spec.fix,
        confidence: i.confidence,
        fileId: i.fileId,
        fileName: i.fileId ? names.get(i.fileId) : undefined,
      });
    });
  },
};

/** App settings for sound (streaming platforms normalise to about −14 LUFS). */
export const AUDIO_PEAK_MAX_DBFS = -1;
export const AUDIO_LOUDNESS_MIN_LUFS = -20;
export const AUDIO_LOUDNESS_MAX_LUFS = -9;

const audioRule: Rule<QcContext> = {
  id: "image.audio",
  category: CATEGORY,
  appliesTo: VIDEO_TYPES,
  needs: ["audio analysis"],
  defaultSeverity: "minor",
  mandatory: false,
  run(context) {
    const audio = context.detections?.audio;
    if (!audio) return [notVerified(this.id, CATEGORY, "Sound", "minor", NEEDS_ANALYSIS)];
    const make = (id: string, title: string) => findingFor(`${this.id}.${id}`, CATEGORY, title);
    if (!audio.hasAudio) {
      return [
        make("present", "Sound")({
          severity: "suggestion",
          status: "failed",
          expected: "A sound track",
          detected: "No sound",
          explanation: "The video has no sound. That can be intentional; check it is.",
          suggestedFix: "Add music or voice if the video is meant to have sound.",
          confidence: audio.confidence,
        }),
      ];
    }
    const findings: Finding[] = [];
    if (audio.peakDbfs !== undefined) {
      const ok = audio.peakDbfs <= AUDIO_PEAK_MAX_DBFS;
      findings.push(
        make("peak", "Sound peaks")({
          severity: "minor",
          status: ok ? "passed" : "failed",
          expected: `Peaks at or below ${AUDIO_PEAK_MAX_DBFS} dBFS`,
          detected: `${audio.peakDbfs.toFixed(1)} dBFS`,
          explanation: ok ? "No clipping." : "The loudest moments are at full scale and may crackle or distort.",
          suggestedFix: `Lower the level so peaks stay at or below ${AUDIO_PEAK_MAX_DBFS} dBFS.`,
          confidence: audio.confidence,
        })
      );
    }
    if (audio.integratedLufs !== undefined) {
      const l = audio.integratedLufs;
      const ok = l >= AUDIO_LOUDNESS_MIN_LUFS && l <= AUDIO_LOUDNESS_MAX_LUFS;
      findings.push(
        make("loudness", "Loudness")({
          severity: "suggestion",
          status: ok ? "passed" : "failed",
          expected: `${AUDIO_LOUDNESS_MIN_LUFS} to ${AUDIO_LOUDNESS_MAX_LUFS} LUFS`,
          detected: `${l.toFixed(1)} LUFS`,
          explanation: ok ? "A typical loudness for social video." : l < AUDIO_LOUDNESS_MIN_LUFS ? "The sound is quiet compared with other videos." : "The sound is loud compared with other videos.",
          suggestedFix: "Adjust the overall level to around −14 LUFS.",
          confidence: audio.confidence,
        })
      );
    }
    return findings.length ? findings : [notVerified(this.id, CATEGORY, "Sound", "minor", "The sound's level wasn't measured.")];
  },
};

export const IMAGE_RULES: readonly Rule<QcContext>[] = [qualityRule, audioRule];
