import { describe, expect, it } from 'vitest';
import { CreateOwnerRequest, LoginRequest } from './auth.js';

describe('CreateOwnerRequest', () => {
  it('accepts a password of 12 characters and trims the username', () => {
    expect(CreateOwnerRequest.parse({ username: ' owner ', password: 'a'.repeat(12) })).toEqual({
      username: 'owner',
      password: 'a'.repeat(12),
    });
  });

  it('refuses a password shorter than 12 characters', () => {
    const result = CreateOwnerRequest.safeParse({ username: 'owner', password: 'a'.repeat(11) });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('at least 12 characters');
  });

  it('refuses an empty username and an oversized password', () => {
    expect(CreateOwnerRequest.safeParse({ username: '  ', password: 'a'.repeat(12) }).success).toBe(
      false,
    );
    expect(
      CreateOwnerRequest.safeParse({ username: 'owner', password: 'a'.repeat(1025) }).success,
    ).toBe(false);
  });
});

describe('LoginRequest', () => {
  it('does not apply the password rules, so a short password is only a failed login', () => {
    expect(LoginRequest.safeParse({ username: 'owner', password: 'short' }).success).toBe(true);
  });
});
