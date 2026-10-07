/**
 * npm run company:grant
 * npm run company:grant -- "<company name or ID>" <email>
 *
 * Gives a user access to a company (D13). Whoever creates a company gets
 * access automatically and admins see every company, so this is only
 * needed to let another designer work on a company. Without arguments it
 * asks for the company and the email.
 */
import { grantCompanyAccess } from "@/lib/company/grant";
import { loadLocalEnv, openDatabase } from "./lib/env";
import { ask, PromptCancelledError } from "./lib/prompt";

async function main() {
  loadLocalEnv();
  const [companyArg, emailArg] = process.argv.slice(2);
  const { db, close } = openDatabase();

  try {
    console.log("\nGive a user access to a company\n");
    const company = companyArg ?? (await ask("Company name or ID: "));
    const email = emailArg ?? (await ask("User's email: "));

    const result = await grantCompanyAccess(db, { company, email });
    if (!result.ok) {
      console.log(result.error);
      console.log("Nothing was changed.");
      process.exitCode = 1;
      return;
    }
    console.log(
      result.alreadyMember
        ? `${result.userName} already has access to ${result.companyName}. Nothing was changed.`
        : `${result.userName} can now open ${result.companyName}.`
    );
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof PromptCancelledError) {
    console.log("\nCancelled. Nothing was changed.");
  } else {
    console.error(`Could not give access: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
});
