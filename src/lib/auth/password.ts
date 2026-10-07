import "server-only";
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with scrypt (built into Node — no native add-on).
 *
 * Stored as `scrypt$<log2 N>$<r>$<p>$<salt>$<hash>` (salt and hash in
 * base64), so the cost can be raised later without breaking old hashes.
 * The password itself is never stored or logged.
 */

export type ScryptCost = { logN: number; r: number; p: number };

/** 64 MiB of memory per hash (N = 2^16, r = 8, p = 2) — an OWASP-recommended setting. */
export const DEFAULT_COST: ScryptCost = { logN: 16, r: 8, p: 2 };

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

// Bounds on what a stored hash may ask for, so a damaged or hostile value
// can't make verification use gigabytes of memory.
const LIMITS = { logN: [10, 20], r: [1, 32], p: [1, 16] } as const;

function derive(password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  const N = 2 ** cost.logN;
  const options: ScryptOptions = {
    N,
    r: cost.r,
    p: cost.p,
    maxmem: 256 * N * cost.r, // twice what scrypt needs
  };
  return new Promise((resolve, reject) => {
    // NFKC so the same password typed on different keyboards matches.
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, options, (error, key) =>
      error ? reject(error) : resolve(key)
    );
  });
}

export async function hashPassword(
  password: string,
  cost: ScryptCost = DEFAULT_COST
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, cost);
  return [
    "scrypt",
    cost.logN,
    cost.r,
    cost.p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

function inRange(value: number, [min, max]: readonly [number, number]) {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** True only if `password` matches `stored`. A malformed hash never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [logN, r, p] = parts.slice(1, 4).map(Number);
  if (!inRange(logN, LIMITS.logN) || !inRange(r, LIMITS.r) || !inRange(p, LIMITS.p)) {
    return false;
  }

  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false;

  const actual = await derive(password, salt, { logN, r, p });
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

/**
 * A hash of a random password at the normal cost. Sign-in checks against it
 * when the email has no account, so a wrong email takes as long as a wrong
 * password and response time doesn't reveal which emails exist.
 */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString("hex"));
  return dummyHash;
}
