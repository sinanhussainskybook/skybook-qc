/**
 * npm run qc:cleanup
 *
 * Deletes every expired QC session (D11) — its requirements, file records
 * and files in the temporary bucket. The app already does this whenever
 * someone opens Start QC; this command covers quiet periods and can be run
 * on a schedule once hosting is chosen (D10).
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
