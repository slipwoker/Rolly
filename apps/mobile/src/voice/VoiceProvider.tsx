/** One voice session for the whole app, so the conversation keeps going while you look at another screen. */
import * as SecureStore from "expo-secure-store";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { useVoice } from "./useVoice";

export type ConvLang = "he" | "en" | "auto";
type Ctx = Omit<ReturnType<typeof useVoice>, "start"> & {
  lang: ConvLang; setLang: (l: ConvLang) => void;
  /** Expected trip length; sent as journey.duration_min so ROLLY paces the conversation. null = not given. */
  minutes: number | null; setMinutes: (m: number | null) => void;
  start: () => Promise<void>;
};

const VoiceCtx = createContext<Ctx | null>(null);
const LANG_KEY = "rolly.conv_lang";
const isLang = (v: unknown): v is ConvLang => v === "he" || v === "en" || v === "auto";

/**
 * The conversation language decides which speech recogniser listens, so it never follows the phone's system language
 * (an English-language iPhone had Hebrew speech recognised by the English model). It is, in this order: what the user
 * picked with the language button (remembered on this phone), the language of their profile, Hebrew.
 */
export function VoiceProvider({ children }: { children: ReactNode }) {
  const v = useVoice();
  const [lang, setLangState] = useState<ConvLang>("he");
  const [explicit, setExplicit] = useState(false);
  const [minutes, setMinutes] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await SecureStore.getItemAsync(LANG_KEY).catch(() => null);
      if (cancelled) return;
      if (isLang(saved)) { setLangState(saved); setExplicit(true); return; }
      const me = await api<{ preferred_language: "he" | "en" | null }>("/v1/me").catch(() => null);
      if (!cancelled && me?.preferred_language) setLangState(me.preferred_language);
    })();
    return () => { cancelled = true; };
  }, []);

  const setLang = (l: ConvLang) => {
    setLangState(l);
    setExplicit(true);
    void SecureStore.setItemAsync(LANG_KEY, l).catch(() => {});
  };
  const start = () => v.start(lang, false, minutes ? { duration_min: minutes } : undefined, explicit);
  return <VoiceCtx.Provider value={{ ...v, start, lang, setLang, minutes, setMinutes }}>{children}</VoiceCtx.Provider>;
}

export function useVoiceSession(): Ctx {
  const v = useContext(VoiceCtx);
  if (!v) throw new Error("useVoiceSession outside VoiceProvider");
  return v;
}
