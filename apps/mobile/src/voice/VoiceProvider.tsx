/** One voice session for the whole app, so the conversation keeps going while you look at another screen. */
import * as SecureStore from "expo-secure-store";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { LANG_KEY, cachedLang, setUiLang, uiLang, type UiLang } from "../i18n";
import { useVoice } from "./useVoice";

/** Hebrew or English. ("auto", the old language button's third choice, is gone: a guessed language sent Hebrew speech
 *  to the English recogniser, P1-D23.) */
export type ConvLang = UiLang;
type Ctx = Omit<ReturnType<typeof useVoice>, "start"> & {
  lang: ConvLang; setLang: (l: ConvLang) => void;
  /** Expected trip length; sent as journey.duration_min so ROLLY paces the conversation. null = not given. */
  minutes: number | null; setMinutes: (m: number | null) => void;
  start: () => Promise<void>;
};

const VoiceCtx = createContext<Ctx | null>(null);

/**
 * The conversation language has one home: the user's profile (`preferred_language`), set in Personalisation. It is
 * cached on the phone so the app opens in that language at once, and the whole app's text follows it (setUiLang).
 * It decides which speech recogniser listens, so it never follows the phone's system language (P1-D23); before
 * anyone chooses, it is Hebrew. A choice made with the old home-screen language button is moved into the profile once.
 */
export function VoiceProvider({ children }: { children: ReactNode }) {
  const v = useVoice();
  const [lang, setLangState] = useState<ConvLang>(uiLang);
  const [minutes, setMinutes] = useState<number | null>(null);

  const adopt = (l: ConvLang) => {
    setLangState(l);
    try { SecureStore.setItem(LANG_KEY, l); } catch { /* keep the in-memory choice */ }
    setUiLang(l);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const me = await api<{ preferred_language: ConvLang | null }>("/v1/me").catch(() => null);
      if (cancelled || !me) return;
      if (me.preferred_language) adopt(me.preferred_language);
      else {
        // first run after the language button was removed: keep the choice it left on the phone
        const local = cachedLang();
        if (local) void api("/v1/me", { method: "PATCH", body: { preferred_language: local } }).catch(() => {});
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setLang = (l: ConvLang) => {
    adopt(l);
    void api("/v1/me", { method: "PATCH", body: { preferred_language: l } }).catch(() => { /* the phone keeps it; sent with every session */ });
  };
  // always explicit: the language is the user's (or the Hebrew default), never something the app guessed
  const start = () => v.start(lang, false, minutes ? { duration_min: minutes } : undefined, true);
  return <VoiceCtx.Provider value={{ ...v, start, lang, setLang, minutes, setMinutes }}>{children}</VoiceCtx.Provider>;
}

export function useVoiceSession(): Ctx {
  const v = useContext(VoiceCtx);
  if (!v) throw new Error("useVoiceSession outside VoiceProvider");
  return v;
}
