/**
 * npm run qc:cleanup
 *
 * Deletes expired QC sessions (D11), up to 50 per run — their requirements,
 * file records and files in the temporary bucket. The worker already does
 * this every hour and the app whenever someone opens Start QC; this command
 * is for running it by hand.
 */
import { purgeExpiredSessions } from "@/lib/qc/session";
import { getQcStorage } from "@/lib/storage/qc-storage";
import { loadLocalEnv, openDatabase } from "./lib/env";

async function main() {
  loadLocalEnv();
  const { db, close } = openDatabase();
  try {
    const storage = getQcStorage();
    if (!storage) console.log("Note: Storage isn't set up; sessions with files are kept until it is.");
    const removed = await purgeExpiredSessions(db, storage, new Date());
    console.log(removed === 0 ? "No expired QC sessions." : `Deleted ${removed} expired QC session(s).`);
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(`Clean-up failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
