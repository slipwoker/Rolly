/**
 * Day or night by the real sun, so ROLLY's avatar sky goes dark when it is dark outside (16:40 in a Tel Aviv
 * November, 19:50 in June) rather than at a fixed hour.
 *
 * No location permission is asked for a backdrop: the place comes from the phone's time zone (a known city for the
 * common ones, otherwise a longitude from the zone's standard offset). That is accurate to a few minutes in Israel
 * and to well under an hour almost anywhere else.
 */
import { getCalendars } from "expo-localization";

export interface Place { lat: number; lon: number }

/** Coordinates for the time zones ROLLY is mostly used in; others are estimated (placeForTimeZone). */
const KNOWN: Record<string, Place> = {
  "Asia/Jerusalem": { lat: 32.08, lon: 34.78 }, "Asia/Tel_Aviv": { lat: 32.08, lon: 34.78 }, Israel: { lat: 32.08, lon: 34.78 },
  "Europe/London": { lat: 51.51, lon: -0.13 }, "Europe/Paris": { lat: 48.86, lon: 2.35 }, "Europe/Berlin": { lat: 52.52, lon: 13.4 },
  "America/New_York": { lat: 40.71, lon: -74.01 }, "America/Chicago": { lat: 41.88, lon: -87.63 },
  "America/Denver": { lat: 39.74, lon: -104.99 }, "America/Los_Angeles": { lat: 34.05, lon: -118.24 },
};
const SOUTH = /^(Australia\/|Pacific\/Auckland|America\/(Sao_Paulo|Argentina|Santiago|Montevideo)|Africa\/Johannesburg)/;

/** Where the phone probably is, from its IANA time zone. */
export function placeForTimeZone(tz: string, now: Date = new Date()): Place {
  if (KNOWN[tz]) return KNOWN[tz];
  // the zone's standard (winter) offset puts the longitude within a zone's width of the truth
  const jan = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), jul = new Date(Date.UTC(now.getUTCFullYear(), 6, 1));
  const offsetH = Math.min(zoneOffsetHours(tz, jan), zoneOffsetHours(tz, jul));
  return { lat: SOUTH.test(tz) ? -33 : 40, lon: Math.max(-180, Math.min(180, offsetH * 15)) };
}

function zoneOffsetHours(tz: string, at: Date): number {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric",
      day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(at).map((x) => [x.type, x.value]));
    const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    return (local - at.getTime()) / 3600_000;
  } catch {
    return -at.getTimezoneOffset() / 60;
  }
}

function devicePlace(now: Date): Place {
  let tz = "";
  try { tz = getCalendars()[0]?.timeZone ?? ""; } catch { /* fall through */ }
  if (!tz) { try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""; } catch { /* fall through */ } }
  return tz ? placeForTimeZone(tz, now) : { lat: 40, lon: -now.getTimezoneOffset() / 4 };
}

const RAD = Math.PI / 180;
const ZENITH = 90.833; // official sunrise/sunset: the sun's upper edge on the horizon, with refraction

/**
 * Sunrise or sunset (ms since epoch) on the given UTC day, or "up"/"down" when the sun never crosses the horizon that
 * day (polar summer/winter). The classic almanac algorithm (US Naval Observatory), good to about a minute.
 */
function sunEvent(dayUtc: number, place: Place, rising: boolean): number | "up" | "down" {
  const d = new Date(dayUtc);
  const n = Math.floor((dayUtc - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000);
  const lngHour = place.lon / 15;
  const t = n + ((rising ? 6 : 18) - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  const L = mod(M + 1.916 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 282.634, 360);
  let RA = mod(Math.atan(0.91764 * Math.tan(L * RAD)) / RAD, 360);
  RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
  const sinDec = 0.39782 * Math.sin(L * RAD), cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(ZENITH * RAD) - sinDec * Math.sin(place.lat * RAD)) / (cosDec * Math.cos(place.lat * RAD));
  if (cosH > 1) return "down";
  if (cosH < -1) return "up";
  const H = (rising ? 360 - Math.acos(cosH) / RAD : Math.acos(cosH) / RAD) / 15;
  const UT = mod(H + RA - 0.06571 * t - 6.622 - lngHour, 24);
  let at = dayUtc + UT * 3600_000;
  // keep the event on the same local solar day as noon at this longitude
  const noon = dayUtc + (12 - lngHour) * 3600_000;
  if (at - noon > 12 * 3600_000) at -= 86_400_000;
  if (noon - at > 12 * 3600_000) at += 86_400_000;
  return at;
}
const mod = (a: number, b: number) => ((a % b) + b) % b;

/** The UTC midnight of the local solar day `now` falls on at this longitude. */
function solarDay(now: number, place: Place, shiftDays = 0): number {
  const d = new Date(now + (place.lon / 15) * 3600_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + shiftDays);
}

function sunTimes(now: Date, place: Place, shiftDays = 0) {
  const day = solarDay(now.getTime(), place, shiftDays);
  return { rise: sunEvent(day, place, true), set: sunEvent(day, place, false) };
}

/** Is the sun down at `now`? Falls back to night 19:00–05:59 if anything goes wrong. */
export function isNight(now: Date = new Date(), place: Place = devicePlace(now)): boolean {
  try {
    const { rise, set } = sunTimes(now, place);
    if (rise === "down" || set === "down") return true;
    if (rise === "up" || set === "up") return false;
    const t = now.getTime();
    return t < rise || t >= set;
  } catch {
    const h = now.getHours();
    return h >= 19 || h < 6;
  }
}

/** Milliseconds until the next sunrise or sunset, so the avatar flips on time without polling (capped at 6 h). */
export function msUntilSwitch(now: Date = new Date(), place: Place = devicePlace(now)): number {
  const t = now.getTime();
  const events = [0, 1].flatMap((shift) => {
    const { rise, set } = sunTimes(now, place, shift);
    return [rise, set].filter((x): x is number => typeof x === "number");
  }).filter((x) => x > t).sort((a, b) => a - b);
  return Math.min(events.length ? events[0] - t : 6 * 3600_000, 6 * 3600_000);
}
