import { describe, expect, it } from "vitest";
import { isNight, msUntilSwitch } from "../src/ui/daypart";

const at = (h: number, m = 0) => new Date(2026, 10, 26, h, m, 0, 0);
const H = 3600_000;

describe("daypart", () => {
  it("is day from 06:00 to 18:59 and night otherwise", () => {
    expect(isNight(at(5, 59))).toBe(true);
    expect(isNight(at(6))).toBe(false);
    expect(isNight(at(12))).toBe(false);
    expect(isNight(at(18, 59))).toBe(false);
    expect(isNight(at(19))).toBe(true);
    expect(isNight(at(0))).toBe(true);
  });

  it("counts down to the next switch", () => {
    expect(msUntilSwitch(at(18))).toBe(H);
    expect(msUntilSwitch(at(5, 30))).toBe(H / 2);
    expect(msUntilSwitch(at(23))).toBe(7 * H); // across midnight to 06:00
    expect(msUntilSwitch(at(6))).toBe(13 * H);
  });
});
