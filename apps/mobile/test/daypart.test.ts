import { describe, expect, it, vi } from "vitest";

vi.mock("expo-localization", () => ({ getCalendars: () => [{ timeZone: "Asia/Jerusalem" }] }));
const { isNight, msUntilSwitch, placeForTimeZone } = await import("../src/ui/daypart");

const TLV = placeForTimeZone("Asia/Jerusalem");
/** Israel local time (IST = UTC+2 in winter, IDT = UTC+3 in summer) as an instant. */
const il = (iso: string, offset: 2 | 3) => new Date(Date.parse(`${iso}:00Z`) - offset * 3600_000);
const MIN = 60_000;

describe("daypart: the real sun", () => {
  it("goes dark at a Tel Aviv November sunset (~16:38), not at 19:00", () => {
    expect(isNight(il("2026-11-26T15:30", 2), TLV)).toBe(false);
    expect(isNight(il("2026-11-26T16:30", 2), TLV)).toBe(false);
    expect(isNight(il("2026-11-26T16:50", 2), TLV)).toBe(true);
    expect(isNight(il("2026-11-26T17:38", 2), TLV)).toBe(true); // the reported case
    expect(isNight(il("2026-11-26T23:00", 2), TLV)).toBe(true);
    expect(isNight(il("2026-11-27T06:00", 2), TLV)).toBe(true);  // sunrise ~06:21
    expect(isNight(il("2026-11-27T06:40", 2), TLV)).toBe(false);
  });

  it("stays light until ~19:50 in June", () => {
    expect(isNight(il("2026-06-21T19:30", 3), TLV)).toBe(false);
    expect(isNight(il("2026-06-21T20:10", 3), TLV)).toBe(true);
    expect(isNight(il("2026-06-21T05:20", 3), TLV)).toBe(true);  // sunrise ~05:33
    expect(isNight(il("2026-06-21T05:50", 3), TLV)).toBe(false);
  });

  it("counts down to the next sunset / sunrise", () => {
    const toSunset = msUntilSwitch(il("2026-11-26T16:00", 2), TLV);
    expect(toSunset).toBeGreaterThan(30 * MIN);
    expect(toSunset).toBeLessThan(45 * MIN);
    // at night the wait is capped at 6 h and re-checked, so it never sleeps through a sunrise
    expect(msUntilSwitch(il("2026-11-26T20:00", 2), TLV)).toBe(6 * 3600_000);
    const toSunrise = msUntilSwitch(il("2026-11-27T05:00", 2), TLV);
    expect(toSunrise).toBeGreaterThan(70 * MIN);
    expect(toSunrise).toBeLessThan(90 * MIN);
  });

  it("uses the phone's time zone when no place is given", () => {
    expect(isNight(il("2026-11-26T17:38", 2))).toBe(true);
    expect(isNight(il("2026-11-26T12:00", 2))).toBe(false);
  });

  it("estimates places it doesn't know from the zone's offset", () => {
    const tokyo = placeForTimeZone("Asia/Tokyo");
    expect(tokyo.lon).toBe(135);
    expect(tokyo.lat).toBe(40);
    expect(placeForTimeZone("Australia/Sydney").lat).toBeLessThan(0);
    // Tokyo (UTC+9): noon local is day, 22:00 local is night
    expect(isNight(new Date(Date.parse("2026-11-26T03:00:00Z")), tokyo)).toBe(false);
    expect(isNight(new Date(Date.parse("2026-11-26T13:00:00Z")), tokyo)).toBe(true);
  });

  it("handles polar day and night", () => {
    const north = { lat: 78, lon: 15 };
    expect(isNight(new Date(Date.parse("2026-12-21T12:00:00Z")), north)).toBe(true);
    expect(isNight(new Date(Date.parse("2026-06-21T00:00:00Z")), north)).toBe(false);
  });
});
