/**
 * npm run user:create
 *
 * Creates a Skybook AI QC account (D2 — there is no sign-up page).
 * Asks for the name, email, role and password in the terminal. The password
 * is typed twice, never shown, never passed as an argument (so it can't end
 * up in shell history) and only its hash is saved.
 */
import { createUser } from "@/lib/auth/create-user";
import { ROLES } from "@/lib/auth/roles";
import {
  checkEmail,
  checkName,
  checkPassword,
  checkRole,
  PASSWORD_MIN_LENGTH,
  type Checked,
} from "@/lib/auth/user-input";
import { loadLocalEnv, openDatabase } from "./lib/env";
import { ask, askHidden, PromptCancelledError } from "./lib/prompt";

/** Ask until the answer passes `check`. */
async function askUntilValid<T>(
  question: string,
  check: (answer: string) => Checked<T>
): Promise<T> {
  for (;;) {
    const result = check(await ask(question));
    if (result.ok) return result.value;
    console.log(`  ${result.error}`);
  }
}

async function askPassword(email: string): Promise<string> {
  for (;;) {
    const password = await askHidden(`Password (at least ${PASSWORD_MIN_LENGTH} characters, hidden): `);
    const confirmation = await askHidden("Type the password again: ");
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

    console.log("\nCreate a Skybook AI QC user\n");
    const name = await askUntilValid("Full name: ", checkName);
    const email = await askUntilValid("Email: ", checkEmail);
    const role = await askUntilValid(`Role (${ROLES.join(" / ")}): `, checkRole);
    const password = await askPassword(email);

    console.log(`\n  Name:  ${name}\n  Email: ${email}\n  Role:  ${role}\n`);
    const confirm = (await ask("Create this user? (y/N): ")).trim().toLowerCase();
    if (confirm !== "y" && confirm !== "yes") {
      console.log("Nothing was created.");
      return;
    }

    const result = await createUser(db, {
      name,
      email,
      role,
      password,
      passwordConfirmation: password,
    });

    if (!result.ok) {
      for (const message of Object.values(result.errors)) console.log(`  ${message}`);
      console.log("Nothing was created.");
      process.exitCode = 1;
      return;
    }
    console.log(`Created ${result.user.role} account for ${result.user.email}.`);
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof PromptCancelledError) {
    console.log("\nCancelled. Nothing was created.");
  } else {
    console.error(`Could not create the user: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
});
