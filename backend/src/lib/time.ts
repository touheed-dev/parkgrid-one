/** All server logic is UTC. IST (UTC+05:30, no DST) is used only for display and labels. */
const IST_OFFSET_MS = 5.5 * 3_600_000;

export function ceilHours(start: Date, end: Date): number {
  return Math.ceil((end.getTime() - start.getTime()) / 1000 / 3600);
}

/** The original SQL checks 15-minute alignment on the IST wall clock; +05:30 is a multiple of 15 min. */
export function isAlignedTo15Min(d: Date): boolean {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return ist.getUTCMinutes() % 15 === 0 && ist.getUTCSeconds() === 0;
}

/** YYYYMMDD of the IST calendar day (booking references / receipts). */
export function istDateStamp(d = new Date()): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10).replaceAll("-", "");
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}
