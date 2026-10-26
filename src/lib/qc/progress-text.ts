/**
 * What the designer reads while a design is checked or a brief is read: which step it's on and roughly how
 * long it takes. The worker records the step's name as it goes ("Reading text", "Checking the design").
 */

type RunProgress = { status: string; stage: string | null; done: number; total: number; provider?: string | null };

/** Setup stages before the numbered steps begin. */
const SETUP = new Set(["Starting", "Preparing files"]);

/** One line: "Waiting to start", "Preparing the files", "Step 2 of 4: Reading text" or "Preparing the result". */
export function progressLine(run: RunProgress, working: string): string {
  if (run.status === "queued") return "Waiting to start";
  if (run.total <= 0 || !run.stage || SETUP.has(run.stage)) return "Preparing the files";
  if (run.done >= run.total) return "Preparing the result";
  const name = run.stage === "Finished" ? working : run.stage;
  return `Step ${run.done + 1} of ${run.total}: ${name}`;
}

/** A realistic time to expect, by what's being analysed and with which provider. */
export function expectedTime(kind: "content" | "information", provider?: string | null): string {
  if (provider === "local") return "Local AI can take several minutes per design.";
  if (provider === "mock") return "Sample data: a few seconds.";
  return kind === "information" ? "Usually a few seconds." : "Usually under a minute.";
}
