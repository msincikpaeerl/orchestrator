import { z } from 'zod';

/** Minimum password length of the owner account (01, section 3.11). */
export const PASSWORD_MIN_LENGTH = 12;
/** Upper bound so a request cannot make the server hash megabytes of text. */
export const PASSWORD_MAX_LENGTH = 1024;

export const Username = z.string().trim().min(1, 'required').max(64, 'at most 64 characters');

export const NewPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `at least ${String(PASSWORD_MIN_LENGTH)} characters`)
  .max(PASSWORD_MAX_LENGTH, `at most ${String(PASSWORD_MAX_LENGTH)} characters`);

/** `GET /api/setup`: which setup wizard steps are done (02, section 3). Public. */
export const SetupStateResponse = z.object({
  ownerCreated: z.boolean(),
  githubConnected: z.boolean(),
});
export type SetupStateResponse = z.infer<typeof SetupStateResponse>;

/** `POST /api/setup/owner`: wizard step 1. Allowed only while no owner exists; logs in. */
export const CreateOwnerRequest = z.object({ username: Username, password: NewPassword });
export type CreateOwnerRequest = z.infer<typeof CreateOwnerRequest>;

/** `POST /api/auth/login`. Rules are not applied here: a wrong value is only a failed login. */
export const LoginRequest = z.object({
  username: z.string().max(256),
  password: z.string().max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** `GET /api/auth/session`, and the answer to owner creation and login. */
export const SessionResponse = z.object({
  username: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type SessionResponse = z.infer<typeof SessionResponse>;
