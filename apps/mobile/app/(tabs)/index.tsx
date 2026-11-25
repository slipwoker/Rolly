/** Conversation: one large start/stop control, the state, optional captions for debugging. Nothing else. */
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { t, uiLang } from "../../src/i18n";
import { useTheme } from "../../src/ui/theme";
import { useVoice } from "../../src/voice/useVoice";

export default function Conversation() {
  const c = useTheme();
  const v = useVoice();
  const [captions, setCaptions] = useState(false);
  const [lang, setLang] = useState<"he" | "en" | "auto">(uiLang === "en" ? "en" : "he");
  const label = (t as Record<string, string>)[v.state] ?? v.state;
  const color = v.state === "error" ? c.danger : v.active ? c.ok : c.accent;
  return (
    <SafeAreaView style={[s.root, { backgroundColor: c.bg }]}>
      <View style={s.center}>
        <Pressable accessibilityRole="button" accessibilityLabel={v.active ? t.stop : t.start}
          onPress={() => (v.active ? v.stop() : v.start(lang, captions))}
          style={({ pressed }) => [s.big, { backgroundColor: color, opacity: pressed ? 0.85 : 1 }]}>
          <Text style={s.bigText}>{v.active ? t.stop : t.start}</Text>
        </Pressable>
        <Text style={[s.state, { color: c.text }]}>{label}</Text>
        {v.detail && v.state === "error" ? <Text style={{ color: c.dim, textAlign: "center" }}>{v.detail}</Text> : null}
        {v.lastReplyMs !== null ? <Text style={{ color: c.dim }}>{t.latency}: {v.lastReplyMs} ms</Text> : null}
      </View>
      {!v.active ? (
        <View style={s.row}>
          {(["he", "en", "auto"] as const).map((l) => (
            <Pressable key={l} onPress={() => setLang(l)} style={[s.chip, { borderColor: lang === l ? c.accent : c.border }]}>
              <Text style={{ color: lang === l ? c.accent : c.dim }}>{l === "he" ? t.hebrew : l === "en" ? t.english : t.auto}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={s.row}>
        <Text style={{ color: c.dim }}>{t.captions}</Text>
        <Switch value={captions} onValueChange={setCaptions} disabled={v.active} />
      </View>
      {captions ? (
        <ScrollView style={s.captions}>
          {v.captions.map((x, i) => (
            <Text key={i} style={{ color: x.role === "agent" ? c.text : c.dim, marginBottom: 4 }}>{x.role === "agent" ? "ROLLY: " : "› "}{x.text}</Text>
          ))}
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 20 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 18 },
  big: { width: 220, height: 220, borderRadius: 110, alignItems: "center", justifyContent: "center" },
  bigText: { color: "#fff", fontSize: 34, fontWeight: "700" },
  state: { fontSize: 22, fontWeight: "600" },
  row: { flexDirection: "row", gap: 10, alignItems: "center", justifyContent: "center", paddingVertical: 8 },
  chip: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 6 },
  captions: { maxHeight: 180, marginBottom: 8 },
});
