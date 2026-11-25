/** Progress: travel-time goals, what moved forward, open action items, recent conversations. Read-only, lightweight. */
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../../src/api";
import { t, uiLang } from "../../src/i18n";
import { useTheme } from "../../src/ui/theme";

interface Progress {
  goals: { id: string; content: string }[];
  action_items: { id: string; content: string }[];
  progress: { id: string; text: string; created_at: string }[];
  sessions: { id: string; started_at: string; summary: string | null }[];
}

export default function ProgressScreen() {
  const c = useTheme();
  const [data, setData] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setBusy(true); api<Progress>("/v1/progress").then(setData).catch(() => {}).finally(() => setBusy(false)); }, []);
  useFocusEffect(load);
  const date = (s: string) => new Date(s).toLocaleDateString(uiLang === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "short" });
  const Section = ({ title, items }: { title: string; items: { key: string; text: string; sub?: string }[] }) => (
    <View style={[s.card, { backgroundColor: c.card }]}>
      <Text style={[s.h, { color: c.text }]}>{title}</Text>
      {items.length ? items.map((i) => (
        <View key={i.key} style={s.item}>
          <Text style={[s.text, { color: c.text }]}>{i.text}</Text>
          {i.sub ? <Text style={{ color: c.dim, fontSize: 13 }}>{i.sub}</Text> : null}
        </View>
      )) : <Text style={{ color: c.dim }}>{t.nothingYet}</Text>}
    </View>
  );
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={s.root} refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}>
        <Text style={[s.title, { color: c.text }]}>{t.progress}</Text>
        <Section title={t.goals} items={(data?.goals ?? []).map((g) => ({ key: g.id, text: g.content }))} />
        <Section title={t.moved} items={(data?.progress ?? []).map((p) => ({ key: p.id, text: p.text, sub: date(p.created_at) }))} />
        <Section title={t.actionItems} items={(data?.action_items ?? []).map((a) => ({ key: a.id, text: a.content }))} />
        <Section title={t.recent} items={(data?.sessions ?? []).slice(0, 8).map((x) => ({ key: x.id, text: x.summary ?? "—", sub: date(x.started_at) }))} />
      </ScrollView>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  root: { padding: 18, gap: 14 },
  title: { fontSize: 28, fontWeight: "700", textAlign: "left" },
  card: { borderRadius: 14, padding: 14, gap: 8 },
  h: { fontSize: 17, fontWeight: "600", textAlign: "left" },
  item: { gap: 2 },
  text: { fontSize: 16, textAlign: "left" },
});
