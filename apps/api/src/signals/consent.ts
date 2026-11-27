/**
 * Whether Rolly may look at a connected source before a ride (P1-D43).
 * ON unless the user switched it off: no row means on. Accounts that existed when this default was introduced were
 * given explicit "off" rows (migration 009), because they connected their services for "read when I ask".
 */
import type { Db } from "../db/index.ts";

export type SignalSource = "calendar" | "mail" | "whatsapp";
export const SIGNAL_SOURCES: SignalSource[] = ["calendar", "mail", "whatsapp"];

export async function signalEnabled(db: Pick<Db, "query">, userId: string, source: SignalSource): Promise<boolean> {
  const r = await db.query<{ enabled: boolean }>("SELECT enabled FROM signal_consent WHERE user_id=$1 AND source=$2", [userId, source]);
  return r.rows[0]?.enabled !== false;
}

export async function signalSettings(db: Pick<Db, "query">, userId: string): Promise<Record<SignalSource, boolean>> {
  const r = await db.query<{ source: SignalSource; enabled: boolean }>("SELECT source, enabled FROM signal_consent WHERE user_id=$1", [userId]);
  const off = new Set(r.rows.filter((x) => x.enabled === false).map((x) => x.source));
  return { calendar: !off.has("calendar"), mail: !off.has("mail"), whatsapp: !off.has("whatsapp") };
}
