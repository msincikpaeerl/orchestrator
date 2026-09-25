/**
 * Exit code of a refusal that retrying cannot fix (05, section 3.2): the systemd unit does not
 * restart the daemon for it (`RestartPreventExitStatus`). 78 is `EX_CONFIG` of sysexits.h.
 */
export const EXIT_REFUSED = 78;

/** A problem the owner can fix, with a message written for them; no stack trace is shown. */
export class UserError extends Error {
  override name = 'UserError';
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}
