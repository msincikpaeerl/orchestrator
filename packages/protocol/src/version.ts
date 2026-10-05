/**
 * Version of the protocol between the server and daemons (09, section 6).
 * Sent by daemons in `hello`; the server accepts this version and the previous one. Version 2
 * (lot 3) adds pushing, CI and reviews (05, section 3.3).
 */
export const PROTOCOL_VERSION = 2;
