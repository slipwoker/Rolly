/**
 * Home is the conversation: ROLLY's orb in the centre and one mic button. No text input — ROLLY is voice-only.
 * Idle: a short greeting under the orb. Live: the line being said right now; the notes button flips to a chat-style
 * transcript. The session lives in VoiceProvider, so it keeps running while Progress/Personalisation are open.
 */
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type ScrollViewInstance } from "react-native";
import Animated, { FadeIn, FadeInUp } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../src/api";
import { fill, t } from "../src/i18n";
import { Backdrop, CircleButton, PressScale, Row, Sheet, TopBar, Txt, cardStyle } from "../src/ui/components";
import { Orb } from "../src/ui/Orb";
import { radius, spacing, useTheme } from "../src/ui/theme";
import { MicButton, Waveform } from "../src/ui/VoiceParts";
import type { VoiceState } from "../src/voice/controller";
import { useVoiceSession, type ConvLang } from "../src/voice/VoiceProvider";

const LIVE: VoiceState[] = ["listening", "user_speaking", "agent_speaking"];
const LANG_SHORT: Record<ConvLang, string> = { he: "עב", en: "EN", auto: "A" };
const NEXT_LANG: Record<ConvLang, ConvLang> = { he: "en", en: "auto", auto: "he" };

export default function Home() {
  const c = useTheme();
  const v = useVoiceSession();
  const { width } = useWindowDimensions();
  const [chat, setChat] = useState(false);
  const [menu, setMenu] = useState(false);
  const [name, setName] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    api<{ preferred_name: string | null }>("/v1/me").then((m) => setName(m.preferred_name)).catch(() => {});
  }, []));

  const label = (t as Record<string, string>)[v.state] ?? v.state;
  const sub = !v.active ? "" : v.state === "listening" || v.state === "user_speaking" ? t.sayIt : label;
  const last = v.captions[v.captions.length - 1];
  const plainBg = c.dark ? c.bg : "#FFFFFF";
  const showChat = chat && v.captions.length > 0;

  const toggle = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (v.active) void v.stop(); else void v.start(v.lang);
  };
  const go = (path: "/progress" | "/personalisation") => { setMenu(false); router.push(path); };

  return (
    <View style={{ flex: 1 }}>
      <Backdrop variant={showChat ? "wash" : "plain"} />
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
        <TopBar
          start={<CircleButton icon="menu" label={t.menu} onPress={() => setMenu(true)} />}
          title={v.active ? t.speakingTo : ""}
          end={v.captions.length > 0
            ? <CircleButton icon="file-text" label={t.transcript} variant={showChat ? "ink" : "outline"} onPress={() => setChat((x) => !x)} />
            : null}
        />
        <Txt variant="caption" tone="dim" style={[s.center, { minHeight: 18 }]}>{sub}</Txt>

        {showChat ? (
          <Transcript />
        ) : (
          <View style={s.stage}>
            <Pressable accessibilityRole="button" accessibilityLabel={v.active ? t.stop : t.start} onPress={v.active ? undefined : toggle} style={s.orbWrap}>
              <Orb size={Math.min(width * 0.74, 320)} state={v.state} />
            </Pressable>
            <View style={s.lineBox}>
              {v.state === "error" && v.detail ? (
                <View style={s.lineInner}><Txt variant="transcript" tone="danger" style={s.center}>{v.detail}</Txt></View>
              ) : v.active && last ? (
                <View style={s.lineInner}>
                  <Animated.View key={`${v.captions.length}`} entering={FadeIn.duration(240)}>
                    <Txt variant="transcript" tone={last.role === "agent" ? "text" : "dim"}>{last.text}</Txt>
                  </Animated.View>
                </View>
              ) : v.active ? (
                <View style={s.lineInner}><Txt variant="transcript" tone="faint" style={s.center}>{t.waitingFirst}</Txt></View>
              ) : (
                <Animated.View entering={FadeIn.duration(400)} style={s.greeting}>
                  <Txt variant="display" style={s.center}>{name ? fill(t.hiName, { name }) : t.hi}</Txt>
                  <Txt variant="subhead" tone="dim" style={s.center}>{t.startHint}</Txt>
                </Animated.View>
              )}
              {v.active ? <LinearGradient pointerEvents="none" colors={[plainBg, `${plainBg}00`]} style={s.fadeTop} /> : null}
            </View>
          </View>
        )}

        {showChat ? (
          <View style={s.chatBar}>
            <View style={[cardStyle(c), s.pill]}>
              <Waveform level={v.state === "user_speaking" ? 1 : v.state === "agent_speaking" ? 0.7 : v.state === "listening" ? 0.25 : 0} color={c.text} height={20} />
              <Txt variant="caption" tone="dim" numberOfLines={1} style={{ flex: 1 }}>{label}</Txt>
            </View>
            <CircleButton icon={v.active ? "square" : "mic"} label={v.active ? t.stop : t.start} size={52} variant="ink" onPress={toggle} />
          </View>
        ) : (
          <View style={s.controls}>
            <View style={s.side}>
              {!v.active ? (
                <PressScale accessibilityRole="button" accessibilityLabel={t.language} onPress={() => v.setLang(NEXT_LANG[v.lang])}
                  style={[s.langBtn, { borderColor: c.border }]}>
                  <Txt variant="micro">{LANG_SHORT[v.lang]}</Txt>
                </PressScale>
              ) : null}
            </View>
            <MicButton icon={v.active ? "square" : "mic"} label={v.active ? t.stop : t.start} live={LIVE.includes(v.state)} onPress={toggle} />
            <View style={[s.side, { alignItems: "flex-end" }]}>
              {v.active ? <CircleButton icon="x" label={t.endConv} onPress={() => void v.stop()} /> : null}
            </View>
          </View>
        )}
      </SafeAreaView>

      <Sheet visible={menu} onClose={() => setMenu(false)} title={t.menu}>
        <Row icon="trending-up" title={t.progress} sub={t.progressSub} onPress={() => go("/progress")} />
        <Row icon="bookmark" title={t.personalisation} sub={t.memorySub} onPress={() => go("/personalisation")} />
      </Sheet>
    </View>
  );
}

/** Chat-style transcript: ROLLY on the start side with its orb, you on the end side in ink bubbles. */
function Transcript() {
  const c = useTheme();
  const v = useVoiceSession();
  const ref = useRef<ScrollViewInstance>(null);
  return (
    <ScrollView ref={ref} style={{ flex: 1 }} contentContainerStyle={s.chat} onContentSizeChange={() => ref.current?.scrollToEnd({ animated: true })}>
      {v.captions.map((m, i) =>
        m.role === "agent" ? (
          <Animated.View key={i} entering={FadeInUp.duration(260)} style={s.agentRow}>
            <View style={s.avatar}><Orb size={34} still /></View>
            <View style={[cardStyle(c), s.bubble, s.agentBubble]}><Txt variant="body">{m.text}</Txt></View>
          </Animated.View>
        ) : (
          <Animated.View key={i} entering={FadeInUp.duration(260)} style={[s.bubble, s.userBubble, { backgroundColor: c.ink }]}>
            <Txt variant="body" tone="onInk">{m.text}</Txt>
          </Animated.View>
        ),
      )}
      {v.lastReplyMs !== null ? <Txt variant="micro" tone="faint" style={s.center}>{t.latency}: {v.lastReplyMs} ms</Txt> : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  center: { textAlign: "center" },
  stage: { flex: 1, paddingHorizontal: spacing.xxl },
  orbWrap: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 220 },
  lineBox: { height: 150, overflow: "hidden" },
  lineInner: { flex: 1, justifyContent: "flex-end" },
  greeting: { flex: 1, justifyContent: "center", gap: spacing.sm },
  fadeTop: { position: "absolute", top: 0, left: 0, right: 0, height: 56 },
  controls: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.xxl, paddingTop: spacing.md, paddingBottom: spacing.sm },
  side: { width: 44 },
  langBtn: { width: 44, height: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth * 2, alignItems: "center", justifyContent: "center" },
  chat: { padding: spacing.xl, gap: spacing.lg },
  agentRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, maxWidth: "88%" },
  avatar: { marginTop: 2 },
  bubble: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.lg, borderCurve: "continuous" },
  agentBubble: { flexShrink: 1, borderTopStartRadius: 6 },
  userBubble: { alignSelf: "flex-end", maxWidth: "80%", borderTopEndRadius: 6 },
  chatBar: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.sm },
  pill: { flex: 1, height: 52, borderRadius: radius.full, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.xl },
});
