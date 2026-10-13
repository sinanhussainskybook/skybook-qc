import "server-only";
import type { Database } from "@/lib/db/database";
import { EmailAlreadyUsedError, insertUser, type User } from "@/lib/db/users";
import { DEFAULT_COST, hashPassword, type ScryptCost } from "@/lib/auth/password";
import { checkEmail, checkName, checkPassword, checkRole } from "@/lib/auth/user-input";

/**
 * Creates one staff account (used by `npm run user:create` and the admin
 * User Management page). Everything is checked again here, whatever the
 * caller already checked. `mustChangePassword`: the password is temporary.
 */

export type NewUserInput = {
  name: string;
  email: string;
  role: string;
  password: string;
  passwordConfirmation: string;
  mustChangePassword?: boolean;
};

export type CreateUserResult =
  | { ok: true; user: User }
  | { ok: false; errors: Partial<Record<keyof NewUserInput | "form", string>> };

export async function createUser(
  db: Database,
  input: NewUserInput,
  cost: ScryptCost = DEFAULT_COST
): Promise<CreateUserResult> {
  const name = checkName(input.name);
  const email = checkEmail(input.email);
  const role = checkRole(input.role);
  const password = checkPassword(input.password, input.passwordConfirmation, input.email);

  if (!name.ok || !email.ok || !role.ok || !password.ok) {
    return {
      ok: false,
      errors: {
        ...(!name.ok && { name: name.error }),
        ...(!email.ok && { email: email.error }),
        ...(!role.ok && { role: role.error }),
        ...(!password.ok && { password: password.error }),
      },
    };
  }

  try {
    const user = await insertUser(db, {
      name: name.value,
      email: email.value,
      role: role.value,
      passwordHash: await hashPassword(password.value, cost),
      mustChangePassword: input.mustChangePassword ?? false,
    });
    return { ok: true, user };
  } catch (error) {
    if (error instanceof EmailAlreadyUsedError) {
      return { ok: false, errors: { email: "A user with this email already exists." } };
    }
    throw error;
  }
}
