import { describe, expect, it } from 'vitest';
import { SecretUnreadableError, decryptSecret, deriveSecretKey, encryptSecret } from './secrets.js';

const key = deriveSecretKey('a-secret-key-of-at-least-32-characters!');

describe('secret encryption', () => {
  it('decrypts what it encrypted, with a new nonce each time', () => {
    const first = encryptSecret(key, 'github_token', 'value');
    const second = encryptSecret(key, 'github_token', 'value');
    expect(decryptSecret(key, 'github_token', first)).toBe('value');
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.toString('utf8')).not.toContain('value');
  });

  it('refuses another key, another name and a modified ciphertext', () => {
    const secret = encryptSecret(key, 'github_token', 'value');
    const otherKey = deriveSecretKey('another-secret-key-of-32-characters!!');
    expect(() => decryptSecret(otherKey, 'github_token', secret)).toThrow(SecretUnreadableError);
    expect(() => decryptSecret(key, 'other_secret', secret)).toThrow(SecretUnreadableError);
    const tampered = Buffer.from(secret.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(() => decryptSecret(key, 'github_token', { ...secret, ciphertext: tampered })).toThrow(
      SecretUnreadableError,
    );
  });

  it('refuses an unknown scheme version', () => {
    const secret = encryptSecret(key, 'github_token', 'value');
    expect(() => decryptSecret(key, 'github_token', { ...secret, scheme: 2 })).toThrow(
      'unknown encryption scheme 2',
    );
  });
});
