/**
 * npm run user:reset-password
 *
 * Sets a new password for an EXISTING Skybook AI QC account (D2 — there is no
 * password-reset page). Asks for the email, shows whose account it is, then
 * asks for the new password twice. The password is never shown, never passed
 * as an argument (so it can't end up in shell history) and only its hash is
 * saved — with the same rules and scrypt hashing as `npm run user:create`.
 * Only that user's password changes: never their email, name, role or
 * company access, and no user is ever created. They are signed out everywhere
 * and their failed sign-in attempts are cleared, as with a Users page reset.
 */
import { resetPassword } from "@/lib/auth/reset-password";
import { checkEmail, checkPassword, PASSWORD_MIN_LENGTH, type Checked } from "@/lib/auth/user-input";
import { findUserByEmail } from "@/lib/db/users";
import { loadLocalEnv, openDatabase } from "./lib/env";
import { ask, askHidden, PromptCancelledError } from "./lib/prompt";

/** Ask until the answer passes `check`. */
async function askUntilValid<T>(question: string, check: (answer: string) => Checked<T>): Promise<T> {
  for (;;) {
    const result = check(await ask(question));
    if (result.ok) return result.value;
    console.log(`  ${result.error}`);
  }
}

async function askPassword(email: string): Promise<string> {
  for (;;) {
    const password = await askHidden(`New password (at least ${PASSWORD_MIN_LENGTH} characters, hidden): `);
    const confirmation = await askHidden("Type the new password again: ");
    const result = checkPassword(password, confirmation, email);
    if (result.ok) return result.value;
    console.log(`  ${result.error}`);
  }
}

async function main() {
  if (!process.stdin.isTTY) {
    throw new Error("Run this in an interactive terminal, so the password can be typed privately.");
  }

  loadLocalEnv();
  const { db, close } = openDatabase(); // fails early if DATABASE_URL is missing

  try {
    // Check the connection and the table before asking anything.
    try {
      await db.query("select 1 from app_users limit 1");
    } catch (error) {
      throw new Error(
        `Can't reach the users table. Check DATABASE_URL and run "npm run db:migrate" first. (${error instanceof Error ? error.message : String(error)})`
      );
    }

    console.log("\nReset a Skybook AI QC user's password\n");
    const email = await askUntilValid("Email of the existing user: ", checkEmail);
    const user = await findUserByEmail(db, email);
    if (!user) {
      console.log(`  There is no user with the email ${email}. Nothing was changed.`);
      process.exitCode = 1;
      return;
    }

    console.log(`\n  Name:   ${user.name}\n  Email:  ${user.email}\n  Role:   ${user.role}${user.active ? "" : "\n  Note:   this account is switched off (inactive) — a new password won't let it sign in."}\n`);
    const password = await askPassword(user.email);

    const confirm = (await ask(`Set this new password for ${user.email}? (y/N): `)).trim().toLowerCase();
    if (confirm !== "y" && confirm !== "yes") {
      console.log("Nothing was changed.");
      return;
    }

    const result = await resetPassword(db, { email: user.email, password, passwordConfirmation: password });
    if (!result.ok) {
      for (const message of Object.values(result.errors)) console.log(`  ${message}`);
      console.log("Nothing was changed.");
      process.exitCode = 1;
      return;
    }
    console.log(`Password changed for ${result.user.email}. They have been signed out everywhere and can sign in with the new password now.`);
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof PromptCancelledError) {
    console.log("\nCancelled. Nothing was changed.");
  } else {
    console.error(`Could not reset the password: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
});
