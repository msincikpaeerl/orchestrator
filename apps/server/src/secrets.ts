import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { schema } from '@orchestrator/db';
import { eq } from 'drizzle-orm';
import type { Executor } from './database.js';

// Encryption of stored secrets (ADR 0016): AES-256-GCM, key derived from ORCHESTRATOR_SECRET_KEY
// with HKDF-SHA256, a random 96-bit nonce per encryption, the secret's name as associated data.
const SCHEME = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The stored secret cannot be decrypted: ORCHESTRATOR_SECRET_KEY is not the one it was saved with. */
export class SecretUnreadableError extends Error {
  override name = 'SecretUnreadableError';
}

export type SecretKey = Buffer & { readonly __brand: 'SecretKey' };

export function deriveSecretKey(orchestratorSecretKey: string): SecretKey {
  return Buffer.from(
    hkdfSync('sha256', orchestratorSecretKey, 'orchestrator', 'secrets aes-256-gcm v1', 32),
  ) as SecretKey;
}

export interface EncryptedSecret {
  scheme: number;
  nonce: Buffer;
  ciphertext: Buffer;
}

export function encryptSecret(key: SecretKey, name: string, value: string): EncryptedSecret {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(name, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { scheme: SCHEME, nonce, ciphertext };
}

export function decryptSecret(key: SecretKey, name: string, secret: EncryptedSecret): string {
  if (secret.scheme !== SCHEME) {
    throw new SecretUnreadableError(
      `secret ${name}: unknown encryption scheme ${String(secret.scheme)}`,
    );
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, secret.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(name, 'utf8'));
    decipher.setAuthTag(secret.ciphertext.subarray(-TAG_BYTES));
    return Buffer.concat([
      decipher.update(secret.ciphertext.subarray(0, -TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    throw new SecretUnreadableError(`secret ${name} cannot be decrypted with the current key`, {
      cause: error,
    });
  }
}

export async function storeSecret(
  db: Executor,
  key: SecretKey,
  name: string,
  value: string,
): Promise<void> {
  const encrypted = encryptSecret(key, name, value);
  await db
    .insert(schema.secrets)
    .values({ name, ...encrypted })
    .onConflictDoUpdate({
      target: schema.secrets.name,
      set: { ...encrypted, updatedAt: new Date() },
    });
}

export async function loadSecret(
  db: Executor,
  key: SecretKey,
  name: string,
): Promise<string | null> {
  const [row] = await db.select().from(schema.secrets).where(eq(schema.secrets.name, name));
  return row ? decryptSecret(key, name, row) : null;
}
