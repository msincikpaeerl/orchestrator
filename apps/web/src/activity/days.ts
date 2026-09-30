/** Start of a day chosen in the owner's time zone (`2026-09-24`), plus `days`. */
export function dayStart(date: string, days = 0): string | null {
  const match = /^(\d{4})-(\d\d)-(\d\d)$/.exec(date);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days).toISOString();
}
