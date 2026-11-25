/** Home: greeting, four shortcuts, and the "talk to ROLLY" composer that opens the voice screen. */
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../src/api";
import { fill, t, uiLang } from "../src/i18n";
import { Backdrop, CircleButton, Chip, PressScale, Row, Sheet, TopBar, Txt, cardStyle, type IconName } from "../src/ui/components";
import { radius, spacing, useTheme } from "../src/ui/theme";
import { useVoiceSession, type ConvLang } from "../src/voice/VoiceProvider";

const LANGS: ConvLang[] = ["he", "en", "auto"];
const langName = (l: ConvLang) => (l === "he" ? t.hebrew : l === "en" ? t.english : t.auto);

export default function Home() {
  const c = useTheme();
  const v = useVoiceSession();
  const [name, setName] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [langSheet, setLangSheet] = useState(false);

  useFocusEffect(useCallback(() => {
    api<{ preferred_name: string | null }>("/v1/me").then((m) => setName(m.preferred_name)).catch(() => {});
    api<{ goals: { content: string }[]; action_items: { content: string }[] }>("/v1/progress")
      .then((p) => setNext(p.action_items[0]?.content ?? p.goals[0]?.content ?? null)).catch(() => {});
  }, []));

  const talk = (lang: ConvLang = v.lang) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (!v.active) v.setLang(lang);
    router.push({ pathname: "/voice", params: v.active ? {} : { autostart: "1", lang } });
  };
  const other: ConvLang = uiLang === "en" ? "he" : "en";

  const cards: { icon: IconName; title: string; sub: string; onPress: () => void }[] = [
    { icon: "message-circle", title: t.newChat, sub: t.newChatSub, onPress: () => talk() },
    { icon: "globe", title: t.otherLang, sub: t.otherLangSub, onPress: () => talk(other) },
    { icon: "trending-up", title: t.progress, sub: t.progressSub, onPress: () => router.push("/progress") },
    { icon: "bookmark", title: t.memoryCard, sub: t.memorySub, onPress: () => router.push("/personalisation") },
  ];

  return (
    <View style={{ flex: 1 }}>
      <Backdrop />
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
        <TopBar
          start={<CircleButton icon="menu" label={t.menu} onPress={() => setMenu(true)} />}
          end={<CircleButton icon="more-horizontal" label={t.more} onPress={() => setLangSheet(true)} />}
        />
        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
          <Animated.View entering={FadeInDown.duration(420)} style={s.hero}>
            <Txt variant="display" tone="faint" style={s.center}>{name ? fill(t.hiName, { name }) : t.hi}</Txt>
            <Txt variant="display" style={s.center}>{t.howHelp}</Txt>
            <Txt variant="subhead" tone="dim" style={[s.center, { marginTop: spacing.sm, maxWidth: 320 }]}>{t.heroSub}</Txt>
          </Animated.View>

          <View style={s.grid}>
            {cards.map((k, i) => (
              <Animated.View key={k.title} entering={FadeInDown.delay(60 + i * 40).duration(380)} style={s.cell}>
                <PressScale accessibilityRole="button" onPress={k.onPress} style={[cardStyle(c), s.card]}>
                  <View style={s.cardHead}>
                    <Feather name={k.icon} size={18} color={c.text} />
                    <Txt variant="label" style={{ flex: 1 }} numberOfLines={2}>{k.title}</Txt>
                  </View>
                  <Txt variant="caption" tone="dim" numberOfLines={2}>{k.sub}</Txt>
                </PressScale>
              </Animated.View>
            ))}
          </View>
        </ScrollView>

        {/* composer */}
        <View style={[s.dock, { backgroundColor: c.dark ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.5)", borderColor: c.border }]}>
          <PressScale onPress={v.active ? () => router.push("/voice") : undefined} style={s.strip}>
            {v.active ? <View style={[s.dot, { backgroundColor: c.ok }]} /> : <Feather name="zap" size={15} color={c.text} />}
            <Txt variant="label" numberOfLines={1} style={{ flex: 1 }}>
              {v.active ? t.liveNow : next ? fill(t.nextUp, { x: next }) : t.tip}
            </Txt>
          </PressScale>
          <View style={[cardStyle(c), s.composer]}>
            <PressScale accessibilityRole="button" accessibilityLabel={t.talkTo} onPress={() => talk()} scaleTo={0.985} style={{ paddingVertical: spacing.xs }}>
              <Txt variant="body" tone="faint" style={{ fontSize: 17 }}>{t.talkTo}</Txt>
            </PressScale>
            <View style={s.composerRow}>
              <PressScale accessibilityRole="button" accessibilityLabel={t.more} onPress={() => setLangSheet(true)} hitSlop={6}
                style={[s.langPill, { borderColor: c.border }]}>
                <Feather name="globe" size={14} color={c.text} />
                <Txt variant="micro">{langName(v.lang)}</Txt>
              </PressScale>
              <View style={{ flex: 1 }} />
              <CircleButton icon="mic" label={t.start} size={38} onPress={() => talk()} />
              <CircleButton icon="navigation" label={t.start} size={42} variant="ink" flip onPress={() => talk()} />
            </View>
          </View>
        </View>
      </SafeAreaView>

      <Sheet visible={menu} onClose={() => setMenu(false)} title={t.menu}>
        <Row icon="trending-up" title={t.progress} sub={t.progressSub} onPress={() => { setMenu(false); router.push("/progress"); }} />
        <Row icon="bookmark" title={t.personalisation} sub={t.memorySub} onPress={() => { setMenu(false); router.push("/personalisation"); }} />
      </Sheet>
      <Sheet visible={langSheet} onClose={() => setLangSheet(false)} title={t.more}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {LANGS.map((l) => <Chip key={l} label={langName(l)} selected={v.lang === l} onPress={() => { v.setLang(l); setLangSheet(false); }} />)}
        </View>
        {v.active ? <Txt variant="caption" tone="dim">{t.langNext}</Txt> : null}
      </Sheet>
    </View>
  );
}

const s = StyleSheet.create({
  scroll: { flexGrow: 1, justifyContent: "center", paddingHorizontal: spacing.xl, paddingBottom: spacing.lg, gap: spacing.x3 },
  hero: { alignItems: "center", gap: spacing.xxs },
  center: { textAlign: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  cell: { width: "48.2%", flexGrow: 1 },
  card: { padding: spacing.lg, gap: spacing.lg, minHeight: 108 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  dock: { marginHorizontal: spacing.md, marginBottom: spacing.xs, borderRadius: radius.xl, borderCurve: "continuous", borderWidth: StyleSheet.hairlineWidth, padding: spacing.sm, paddingTop: 0 },
  strip: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  dot: { width: 8, height: 8, borderRadius: 4 },
  composer: { borderRadius: radius.xl - 6, padding: spacing.lg, paddingBottom: spacing.md, gap: spacing.xl },
  composerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  langPill: { flexDirection: "row", alignItems: "center", gap: spacing.xs + 2, height: 34, paddingHorizontal: spacing.md, borderRadius: radius.full, borderWidth: StyleSheet.hairlineWidth * 2 },
});
