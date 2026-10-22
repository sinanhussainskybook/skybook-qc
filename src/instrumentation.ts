/**
 * Next.js start-up hook: runs once when the server starts.
 *
 * Starts the QC worker inside the website only when QC_EMBEDDED_WORKER is switched on (off by default),
 * and only on the Node.js server — never in the Edge runtime. Without the setting nothing changes: the
 * website only queues analysis runs, and a separate worker (`npm run qc:worker`) processes them.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { embeddedWorkerEnabled, startEmbeddedWorker } = await import("@/lib/analysis/embedded-worker");
  if (embeddedWorkerEnabled()) startEmbeddedWorker();
}
