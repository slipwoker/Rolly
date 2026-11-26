/** Day or night by the device's local clock: night runs 19:00–05:59. Drives ROLLY's avatar backdrop. */
export const NIGHT_FROM = 19;
export const DAY_FROM = 6;

export function isNight(now: Date = new Date()): boolean {
  const h = now.getHours();
  return h >= NIGHT_FROM || h < DAY_FROM;
}

/** Milliseconds until the next day/night switch, so the avatar flips on time without polling. */
export function msUntilSwitch(now: Date = new Date()): number {
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(isNight(now) ? DAY_FROM : NIGHT_FROM);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}
