import { hash, verify } from '@node-rs/argon2';

// Argon2id with OWASP's minimum recommended cost (ADR 0015), stated here so that a change of
// library default cannot weaken new hashes. Existing hashes keep the parameters they record.
const options = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Argon2id hash in PHC format (`$argon2id$v=19$m=…`), salt included. */
export function hashPassword(password: string): Promise<string> {
  return hash(password, options);
}

/** False for a wrong password and for a malformed hash. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/**
 * Verified against when the username is unknown, so a failed login takes the same time
 * whether or not the username exists.
 */
export const unknownUserHash = await hashPassword('unknown user: never a valid password');
