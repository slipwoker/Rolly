/**
 * Voice: the orb, the line being said right now, and one big mic control. The notes button flips to a chat-style
 * transcript of the whole conversation. Minimising keeps the session running (it lives in VoiceProvider).
 */
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, useWindowDimensions, View, type ScrollViewInstance } from "react-native";
import Animated, { FadeIn, FadeInUp } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { t } from "../src/i18n";
import { Backdrop, CircleButton, PressScale, TopBar, Txt, cardStyle } from "../src/ui/components";
import { Orb } from "../src/ui/Orb";
import { radius, spacing, useTheme } from "../src/ui/theme";
import { MicButton, Waveform } from "../src/ui/VoiceParts";
import type { VoiceState } from "../src/voice/controller";
import { useVoiceSession, type ConvLang } from "../src/voice/VoiceProvider";

const LIVE: VoiceState[] = ["listening", "user_speaking", "agent_speaking"];
const LANG_SHORT: Record<ConvLang, string> = { he: "עב", en: "EN", auto: "A" };
const NEXT_LANG: Record<ConvLang, ConvLang> = { he: "en", en: "auto", auto: "he" };

export default function Voice() {
  const c = useTheme();
  const v = useVoiceSession();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ autostart?: string; lang?: ConvLang }>();
  const [chat, setChat] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || params.autostart !== "1" || v.active) return;
    started.current = true;
    void v.start(params.lang ?? v.lang);
  }, [params.autostart, params.lang, v]);

  const label = (t as Record<string, string>)[v.state] ?? v.state;
  const sub = v.state === "listening" || v.state === "user_speaking" ? t.sayIt : label;
  const last = v.captions[v.captions.length - 1];
  const plainBg = c.dark ? c.bg : "#FFFFFF";

  const toggle = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (v.active) void v.stop(); else void v.start(v.lang);
  };
  const close = () => { if (v.active) void v.stop(); router.back(); };

  return (
    <View style={{ flex: 1 }}>
      <Backdrop variant={chat ? "wash" : "plain"} />
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
        <TopBar
          start={<CircleButton icon="chevron-down" label={t.minimize} onPress={() => router.back()} />}
          title={t.speakingTo}
          end={<CircleButton icon="file-text" label={t.transcript} variant={chat ? "ink" : "outline"} onPress={() => setChat((x) => !x)} />}
        />
        <Txt variant="caption" tone="dim" style={s.center}>{sub}</Txt>

        {chat ? (
          <Transcript />
        ) : (
          <View style={s.stage}>
            <View style={s.orbWrap}><Orb size={Math.min(width * 0.74, 320)} state={v.state} /></View>
            <View style={s.lineBox}>
              <View style={s.lineInner}>
                {v.state === "error" && v.detail ? (
                  <Txt variant="transcript" tone="danger">{v.detail}</Txt>
                ) : last ? (
                  <Animated.View key={`${v.captions.length}`} entering={FadeIn.duration(240)}>
                    <Txt variant="transcript" tone={last.role === "agent" ? "text" : "dim"}>{last.text}</Txt>
                  </Animated.View>
                ) : (
                  <Txt variant="transcript" tone="faint">{v.active ? t.waitingFirst : t.startHint}</Txt>
                )}
              </View>
              <LinearGradient pointerEvents="none" colors={[plainBg, `${plainBg}00`]} style={s.fadeTop} />
            </View>
          </View>
        )}

        {chat ? (
          <View style={s.chatBar}>
            <View style={[cardStyle(c), s.pill]}>
              <Waveform level={v.state === "user_speaking" ? 1 : v.state === "agent_speaking" ? 0.7 : v.state === "listening" ? 0.25 : 0} color={c.text} height={20} />
              <Txt variant="caption" tone="dim" numberOfLines={1} style={{ flex: 1 }}>{label}</Txt>
            </View>
            <CircleButton icon={v.active ? "square" : "mic"} label={v.active ? t.stop : t.start} size={52} variant="ink" onPress={toggle} />
          </View>
        ) : (
          <View style={s.controls}>
            <PressScale accessibilityRole="button" accessibilityLabel={t.more} disabled={v.active} onPress={() => v.setLang(NEXT_LANG[v.lang])}
              style={[s.langBtn, { borderColor: c.border }]}>
              <Txt variant="micro">{LANG_SHORT[v.lang]}</Txt>
            </PressScale>
            <MicButton icon={v.active ? "square" : "mic"} label={v.active ? t.stop : t.start} live={LIVE.includes(v.state)} onPress={toggle} />
            <CircleButton icon="x" label={t.endConv} onPress={close} />
          </View>
        )}
      </SafeAreaView>
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
      {v.captions.length === 0 ? (
        <Txt variant="subhead" tone="faint" style={[s.center, { marginTop: spacing.x4 }]}>{v.active ? t.waitingFirst : t.startHint}</Txt>
      ) : null}
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
  fadeTop: { position: "absolute", top: 0, left: 0, right: 0, height: 56 },
  controls: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.xxl, paddingTop: spacing.md, paddingBottom: spacing.sm },
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
