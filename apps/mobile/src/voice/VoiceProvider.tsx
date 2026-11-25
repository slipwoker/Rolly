/** One voice session for the whole app, so the conversation keeps going while you look at another screen. */
import { createContext, useContext, useState, type ReactNode } from "react";
import { uiLang } from "../i18n";
import { useVoice } from "./useVoice";

export type ConvLang = "he" | "en" | "auto";
type Ctx = Omit<ReturnType<typeof useVoice>, "start"> & {
  lang: ConvLang; setLang: (l: ConvLang) => void;
  /** Expected trip length; sent as journey.duration_min so ROLLY paces the conversation. null = not given. */
  minutes: number | null; setMinutes: (m: number | null) => void;
  start: () => Promise<void>;
};

const VoiceCtx = createContext<Ctx | null>(null);

export function VoiceProvider({ children }: { children: ReactNode }) {
  const v = useVoice();
  const [lang, setLang] = useState<ConvLang>(uiLang === "en" ? "en" : "he");
  const [minutes, setMinutes] = useState<number | null>(null);
  const start = () => v.start(lang, false, minutes ? { duration_min: minutes } : undefined);
  return <VoiceCtx.Provider value={{ ...v, start, lang, setLang, minutes, setMinutes }}>{children}</VoiceCtx.Provider>;
}

export function useVoiceSession(): Ctx {
  const v = useContext(VoiceCtx);
  if (!v) throw new Error("useVoiceSession outside VoiceProvider");
  return v;
}
