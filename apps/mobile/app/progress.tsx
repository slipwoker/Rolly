/** Progress: travel-time goals, what moved forward, open action items, recent conversations. Read-only, lightweight. */
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../src/api";
import { t, uiLang } from "../src/i18n";
import { Backdrop, Card, CircleButton, IconTile, TopBar, Txt, type IconName } from "../src/ui/components";
import { spacing, useTheme } from "../src/ui/theme";

interface Progress {
  goals: { id: string; content: string }[];
  action_items: { id: string; content: string }[];
  progress: { id: string; text: string; created_at: string }[];
  sessions: { id: string; started_at: string; summary: string | null }[];
}
type Item = { key: string; text: string; sub?: string };

export default function ProgressScreen() {
  const c = useTheme();
  const [data, setData] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setBusy(true); api<Progress>("/v1/progress").then(setData).catch(() => {}).finally(() => setBusy(false)); }, []);
  useFocusEffect(load);
  const date = (s: string) => new Date(s).toLocaleDateString(uiLang === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "short" });

  const sections: { icon: IconName; title: string; items: Item[] }[] = [
    { icon: "target", title: t.goals, items: (data?.goals ?? []).map((g) => ({ key: g.id, text: g.content })) },
    { icon: "trending-up", title: t.moved, items: (data?.progress ?? []).map((p) => ({ key: p.id, text: p.text, sub: date(p.created_at) })) },
    { icon: "check-square", title: t.actionItems, items: (data?.action_items ?? []).map((a) => ({ key: a.id, text: a.content })) },
    { icon: "clock", title: t.recent, items: (data?.sessions ?? []).slice(0, 8).map((x) => ({ key: x.id, text: x.summary ?? "—", sub: date(x.started_at) })) },
  ];

  return (
    <View style={{ flex: 1 }}>
      <Backdrop />
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <TopBar start={<CircleButton icon="arrow-left" flip label={t.back} onPress={() => router.back()} />} title={t.progress} />
        <ScrollView contentContainerStyle={s.root} refreshControl={<RefreshControl refreshing={busy} onRefresh={load} tintColor={c.accent} />}>
          {sections.map((sec, i) => (
            <Animated.View key={sec.title} entering={FadeInDown.delay(i * 50).duration(360)}>
              <Card style={s.card}>
                <View style={s.head}>
                  <IconTile icon={sec.icon} />
                  <Txt variant="headline" style={{ flex: 1 }}>{sec.title}</Txt>
                  {sec.items.length ? <Txt variant="micro" tone="faint">{sec.items.length}</Txt> : null}
                </View>
                {sec.items.length ? sec.items.map((it, j) => (
                  <View key={it.key} style={[s.item, j > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border } : null]}>
                    <Txt variant="body">{it.text}</Txt>
                    {it.sub ? <Txt variant="caption" tone="faint">{it.sub}</Txt> : null}
                  </View>
                )) : <Txt variant="subhead" tone="dim">{t.nothingYet}</Txt>}
              </Card>
            </Animated.View>
          ))}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.x4, gap: spacing.md },
  card: { gap: spacing.md },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  item: { gap: spacing.xxs, paddingTop: spacing.md },
});
