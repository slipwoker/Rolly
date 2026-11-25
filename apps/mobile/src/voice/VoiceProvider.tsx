/** One voice session for the whole app, so the conversation keeps going while you look at another screen. */
import { createContext, useContext, useState, type ReactNode } from "react";
import { uiLang } from "../i18n";
import { useVoice } from "./useVoice";

export type ConvLang = "he" | "en" | "auto";
type Ctx = ReturnType<typeof useVoice> & { lang: ConvLang; setLang: (l: ConvLang) => void };

const VoiceCtx = createContext<Ctx | null>(null);

export function VoiceProvider({ children }: { children: ReactNode }) {
  const v = useVoice();
  const [lang, setLang] = useState<ConvLang>(uiLang === "en" ? "en" : "he");
  return <VoiceCtx.Provider value={{ ...v, lang, setLang }}>{children}</VoiceCtx.Provider>;
}

export function useVoiceSession(): Ctx {
  const v = useContext(VoiceCtx);
  if (!v) throw new Error("useVoiceSession outside VoiceProvider");
  return v;
}
