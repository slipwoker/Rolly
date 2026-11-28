import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const forceRTL = vi.fn();
vi.mock("expo-secure-store", () => ({ getItem: (k: string) => store.get(k) ?? null }));
vi.mock("react-native", () => ({ I18nManager: { allowRTL: () => {}, forceRTL, isRTL: false }, Platform: { OS: "ios" } }));
vi.mock("react", () => ({ useEffect: () => {}, useReducer: () => [0, () => {}] }));

const load = async () => { vi.resetModules(); return import("../src/i18n"); };

describe("app language follows the conversation language", () => {
  beforeEach(() => { store.clear(); forceRTL.mockClear(); });

  it("is Hebrew before anyone chooses (never the phone's system language)", async () => {
    const i = await load();
    expect(i.uiLang).toBe("he");
    expect(i.isRTL).toBe(true);
    expect(i.dirStyle).toEqual({ direction: "rtl" });
    expect(i.t.start).toBe("התחלה");
  });

  it("opens in the language cached on the phone", async () => {
    store.set("rolly.conv_lang", "en");
    const i = await load();
    expect(i.uiLang).toBe("en");
    expect(i.isRTL).toBe(false);
    expect(i.t.start).toBe("Start");
  });

  it("ignores the old button's 'auto'", async () => {
    store.set("rolly.conv_lang", "auto");
    const i = await load();
    expect(i.cachedLang()).toBeNull();
    expect(i.uiLang).toBe("he");
  });

  it("switches everything live, and the native direction for the next launch", async () => {
    const i = await load();
    i.setUiLang("en");
    expect(i.uiLang).toBe("en");
    expect(i.t.start).toBe("Start");
    expect(i.dirStyle).toEqual({ direction: "ltr" });
    expect(forceRTL).toHaveBeenCalledWith(false);
    i.setUiLang("en"); // no-op
    expect(forceRTL).toHaveBeenCalledTimes(1);
  });
});
