import { describe, expect, it } from "vitest";
import { formatCode, httpStatus, linkError, normalizePhone, stateView } from "../src/whatsapp";

describe("normalizePhone", () => {
  it("turns Israeli local numbers into digits with the country code", () => {
    expect(normalizePhone("050-123-4567")).toBe("972501234567");
    expect(normalizePhone("0501234567")).toBe("972501234567");
    expect(normalizePhone(" 054 395 1940 ")).toBe("972543951940");
  });
  it("keeps a number that already has the country code", () => {
    expect(normalizePhone("+972 50-123-4567")).toBe("972501234567");
    expect(normalizePhone("972501234567")).toBe("972501234567");
    expect(normalizePhone("00972501234567")).toBe("972501234567");
  });
  it("accepts other countries when written with + or 00", () => {
    expect(normalizePhone("+1 (415) 555-2671")).toBe("14155552671");
    expect(normalizePhone("0044 7911 123456")).toBe("447911123456");
  });
  it("refuses what cannot be a mobile number", () => {
    for (const bad of ["", "abc", "123", "05012345", "0501234567890123", "+97250123"]) expect(normalizePhone(bad)).toBeNull();
  });
});

describe("formatCode", () => {
  it("shows the 8 characters the way WhatsApp does", () => {
    expect(formatCode("cqgyy2fz")).toBe("CQGY-Y2FZ");
    expect(formatCode("CQGY-Y2FZ")).toBe("CQGY-Y2FZ");
    expect(formatCode(" cqgy y2fz ")).toBe("CQGY-Y2FZ");
  });
  it("leaves anything else as it is (cleaned)", () => { expect(formatCode("ab-12")).toBe("AB12"); });
});

describe("stateView", () => {
  it("offers linking only when it can work, and disconnecting only when there is something to remove", () => {
    expect(stateView("unlinked")).toMatchObject({ canLink: true, canUnlink: false, warn: false });
    expect(stateView("connected")).toMatchObject({ canLink: false, canUnlink: true, warn: false });
    expect(stateView("needs_relink")).toMatchObject({ canLink: true, canUnlink: true, warn: true });
    expect(stateView("banned")).toMatchObject({ canLink: false, canUnlink: true, warn: true });
  });
  it("an unknown or unreachable state offers nothing instead of guessing", () => {
    for (const st of ["unavailable", "client_outdated", "something_new"]) expect(stateView(st)).toMatchObject({ text: "waUnavailable", canLink: false, canUnlink: false });
  });
});

describe("errors", () => {
  it("reads the status out of the error api() throws", () => {
    expect(httpStatus(new Error("/v1/whatsapp/link: HTTP 409"))).toBe(409);
    expect(httpStatus(new Error("network down"))).toBeNull();
  });
  it("maps statuses to a message the user can act on", () => {
    expect(linkError(new Error("x: HTTP 409"))).toBe("waErrBusy");
    expect(linkError(new Error("x: HTTP 400"))).toBe("waErrPhone");
    expect(linkError(new Error("x: HTTP 429"))).toBe("waErrLimit");
    expect(linkError(new Error("x: HTTP 502"))).toBe("waErrGeneric");
    expect(linkError("boom")).toBe("waErrGeneric");
  });
});
