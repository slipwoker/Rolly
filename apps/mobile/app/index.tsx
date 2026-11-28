/**
 * Home is the conversation: ROLLY's driving avatar in the centre and one mic button. No text input — ROLLY is voice-only.
 * Idle: a short greeting under the avatar. Live: the line being said right now; the notes button flips to a chat-style
 * transcript. The session lives in VoiceProvider, so it keeps running while Progress/Personalisation are open.
 */
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type ScrollViewInstance } from "react-native";
import Animated, { FadeIn, FadeInUp } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../src/api";
import { fill, t, uiLang, useUiLang } from "../src/i18n";
import { Backdrop, Chip, CircleButton, IconTile, LinkRow, PressScale, Row, Sheet, TopBar, Txt, cardStyle } from "../src/ui/components";
import { MediaCard } from "../src/ui/MediaCard";
import { RollyAvatar } from "../src/ui/RollyAvatar";
import { radius, spacing, useTheme } from "../src/ui/theme";
import { MicButton, Waveform } from "../src/ui/VoiceParts";
import type { VoiceState } from "../src/voice/controller";
import { useVoiceSession } from "../src/voice/VoiceProvider";
import { usePipeline, type PipelineState } from "../src/voice/usePipeline";
import { isNight } from "../src/ui/daypart";

const LIVE: VoiceState[] = ["listening", "user_speaking", "agent_speaking"];
const TRIP_MINUTES = [10, 20, 40] as const;

function greeting(name: string | null): string {
  const h = new Date().getHours();
  // "good evening" once the sun is down (16:37 in a Tel Aviv November), not only from 17:00
  const base = h >= 5 && h < 12 ? t.morning : h >= 12 && h < 17 && !isNight() ? t.afternoon : t.evening;
  return name ? `${base}, ${name}` : base;
}

interface Progress { goals: { content: string }[]; action_items: { content: string }[]; sessions: { summary: string | null }[]; next_up?: { topic: string }[] }

export default function Home() {
  useUiLang();
  const c = useTheme();
  const v = useVoiceSession();
  const pipe = usePipeline(v.active);
  // the moment Rolly is ready after waiting, say so with a light tap (the dimmed mic lights up at the same time)
  const wasBlocked = useRef(false);
  useEffect(() => {
    if (wasBlocked.current && pipe.state === "ready") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    wasBlocked.current = pipe.blocked;
  }, [pipe.state, pipe.blocked]);
  // a conversation that the pipeline refused: re-check, so the screen shows why and waits for it
  useEffect(() => { if (v.state === "error" && /pipeline/i.test(v.detail ?? "")) void pipe.check(); }, [v.state, v.detail, pipe.check]);
  const { width, height } = useWindowDimensions();
  const compact = height < 740; // iPhone SE / mini: smaller idle avatar, one-line recap
  const [chat, setChat] = useState(false);
  const [menu, setMenu] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [recap, setRecap] = useState<{ last: string | null; next: string | null }>({ last: null, next: null });

  useFocusEffect(useCallback(() => {
    api<{ preferred_name: string | null }>("/v1/me").then((m) => setName(m.preferred_name)).catch(() => {});
    api<Progress>("/v1/progress").then((p) => setRecap({
      last: p.sessions.find((x) => x.summary)?.summary ?? null,
      // what ROLLY plans to bring up on this ride; before there is a plan, the first open task or goal
      next: p.next_up?.[0]?.topic ?? p.action_items[0]?.content ?? p.goals[0]?.content ?? null,
    })).catch(() => {});
  }, []));

  const label = (t as Record<string, string>)[v.state] ?? v.state;
  const sub = !v.active ? "" : v.state === "listening" || v.state === "user_speaking" ? t.sayIt : v.state === "music" ? t.tapToTalk : label;
  const last = v.captions[v.captions.length - 1];
  const plainBg = c.dark ? c.bg : "#FFFFFF";
  const showChat = chat && v.captions.length > 0;

  const toggle = () => {
    // nothing to start yet: say so (the status line explains) and look again now
    if (!v.active && pipe.blocked) { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); void pipe.check(); return; }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // while music plays, the big button means "talk": it pauses the music and listens again (the small x ends the conversation)
    if (v.state === "music") void v.resumeFromMusic();
    else if (v.active) void v.stop(); else void v.start();
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
              <RollyAvatar size={v.active ? Math.min(width * 0.74, 320) : compact ? Math.min(width * 0.4, 150) : Math.min(width * 0.56, 240)} state={v.state} />
            </Pressable>
            {!v.active && v.state !== "error" ? (
              <Animated.View entering={FadeIn.duration(400)} style={[s.idle, compact ? { gap: spacing.md } : null]}>
                <View style={{ gap: spacing.xs }}>
                  <Txt variant="display" style={s.center}>{greeting(name)}</Txt>
                  {pipe.blocked
                    ? <PipelineLine state={pipe.state} />
                    : <Txt variant="subhead" tone="dim" style={s.center}>{recap.last || recap.next ? t.startHint : t.intro}</Txt>}
                </View>
                {recap.last || recap.next ? (
                  <PressScale accessibilityRole="button" onPress={() => router.push("/progress")} scaleTo={0.98} style={[cardStyle(c), s.recap]}>
                    {recap.last ? <RecapLine icon="clock" label={t.lastTime} text={recap.last} lines={compact ? 1 : 2} /> : null}
                    {recap.last && recap.next ? <View style={[s.rule, { backgroundColor: c.border }]} /> : null}
                    {recap.next ? <RecapLine icon="flag" label={t.nextUp} text={recap.next} lines={compact ? 1 : 2} /> : null}
                  </PressScale>
                ) : null}
                <View style={{ gap: spacing.sm }}>
                  <Txt variant="micro" tone="faint" style={s.center}>{t.tripLen}</Txt>
                  <View style={s.chips}>
                    {TRIP_MINUTES.map((m) => (
                      <Chip key={m} size="sm" label={fill(t.minShort, { n: String(m) })} selected={v.minutes === m} onPress={() => v.setMinutes(v.minutes === m ? null : m)} />
                    ))}
                    <Chip size="sm" label={t.anyLen} selected={v.minutes === null} onPress={() => v.setMinutes(null)} />
                  </View>
                </View>
              </Animated.View>
            ) : (
            <View style={s.lineBox}>
              {v.state === "error" && v.detail ? (
                <View style={s.lineInner}><Txt variant="transcript" tone="danger" style={s.center}>{friendlyError(v.detail)}</Txt></View>
              ) : v.active && last ? (
                <View style={s.lineInner}>
                  <Animated.View key={`${v.captions.length}`} entering={FadeIn.duration(240)}>
                    <Txt variant="transcript" tone={last.role === "agent" ? "text" : "dim"}>{last.text}</Txt>
                  </Animated.View>
                </View>
              ) : v.active ? (
                <View style={s.lineInner}><Txt variant="transcript" tone="faint" style={s.center}>{t.waitingFirst}</Txt></View>
              ) : null}
              <LinearGradient pointerEvents="none" colors={[plainBg, `${plainBg}00`]} style={s.fadeTop} />
            </View>
            )}
          </View>
        )}

        {showChat ? (
          <View style={s.chatBar}>
            {v.active ? (
              <View style={[cardStyle(c), s.pill]}>
                <Waveform level={v.state === "user_speaking" ? 1 : v.state === "agent_speaking" ? 0.7 : v.state === "listening" ? 0.3 : 0.15} color={c.text} height={22} />
                <Txt variant="caption" tone="dim" numberOfLines={1} style={{ flex: 1 }}>{label}</Txt>
              </View>
            ) : (
              /* no live conversation: say how it ended and how to start a new one (no flat waveform) */
              <View style={{ flex: 1 }}><PressScale accessibilityRole="button" accessibilityLabel={t.start} onPress={toggle} scaleTo={0.98} style={[cardStyle(c), s.pillBody]}>
                <Feather name={v.state === "error" ? "alert-circle" : v.state === "ended" ? "check-circle" : "mic"} size={20}
                  color={v.state === "error" ? c.danger : v.state === "ended" ? c.ok : c.dim} />
                <View style={{ flex: 1 }}>
                  <Txt variant="label" numberOfLines={1}>{label}</Txt>
                  <Txt variant="micro" tone="faint" numberOfLines={1}>{t.startHint}</Txt>
                </View>
              </PressScale></View>
            )}
            <CircleButton icon={v.active && v.state !== "music" ? "square" : "mic"} label={v.state === "music" ? t.tapToTalk : v.active ? t.stop : t.start} size={52} variant="ink" onPress={toggle} />
          </View>
        ) : (
          <View style={s.controls}>
            {/* the conversation language is a setting (Personalisation), not a per-ride control */}
            <View style={s.side} />
            <MicButton icon={v.active && v.state !== "music" ? "square" : "mic"} label={!v.active && pipe.blocked ? pipelineText(pipe.state) : v.state === "music" ? t.tapToTalk : v.active ? t.stop : t.start} live={LIVE.includes(v.state)} onPress={toggle} waiting={!v.active && pipe.blocked} />
            <View style={[s.side, { alignItems: "flex-end" }]}>
              {v.active ? <CircleButton icon="x" label={t.endConv} onPress={() => void v.stop()} /> : null}
            </View>
          </View>
        )}
      </SafeAreaView>

      <Sheet visible={menu} onClose={() => setMenu(false)} title={t.menu}>
        <Row icon="trending-up" title={t.progress} sub={t.progressSub} onPress={() => go("/progress")} />
        <Row icon="bookmark" title={t.personalisation} sub={t.memorySub} onPress={() => go("/personalisation")} />
        {/* the site's legal pages, in the app's language */}
        <View style={[s.legal, { borderColor: c.border }]}>
          <LinkRow icon="shield" label={t.legalPrivacy} onPress={() => { setMenu(false); openSite("privacy"); }} />
          <LinkRow icon="file-text" label={t.legalTerms} onPress={() => { setMenu(false); openSite("terms"); }} />
          <LinkRow icon="eye" label={t.legalAccess} onPress={() => { setMenu(false); openSite("accessibility"); }} />
        </View>
      </Sheet>
    </View>
  );
}

/** Opens a page of heyrolly.ai (privacy, terms, accessibility) in the browser, in the app's language. */
function openSite(page: "privacy" | "terms" | "accessibility") {
  // a beat so the menu starts closing before the browser takes over
  setTimeout(() => void Linking.openURL(`https://heyrolly.ai${uiLang === "en" ? "/en" : ""}/${page}/`).catch(() => {}), 50);
}

/** What the pipeline's state means for the user, in one sentence. */
function pipelineText(state: PipelineState): string {
  return state === "starting" ? t.pipeStarting : state === "busy" ? t.pipeBusy : t.pipeOffline;
}

/** The status line under the greeting while a conversation cannot start yet. */
function PipelineLine({ state }: { state: PipelineState }) {
  const c = useTheme();
  return (
    <View accessibilityLiveRegion="polite" style={s.pipeLine}>
      {state === "starting" ? <ActivityIndicator size="small" color={c.accent} /> : <Feather name={state === "busy" ? "clock" : "cloud-off"} size={16} color={c.dim} />}
      <Txt variant="subhead" tone="dim" style={{ flexShrink: 1, textAlign: "center" }}>{pipelineText(state)}</Txt>
    </View>
  );
}

/** Errors from the voice session are for logs; the user gets a sentence. */
function friendlyError(detail?: string): string {
  if (detail && /pipeline|pod|GPU|worker/i.test(detail)) return t.pipeFailed;
  return t.genericError;
}

/** One line of the "picking up from here" card. */
function RecapLine({ icon, label, text, lines }: { icon: "clock" | "flag"; label: string; text: string; lines: number }) {
  return (
    <View style={s.recapLine}>
      <IconTile icon={icon} tone="soft" />
      <View style={{ flex: 1, gap: spacing.xxs }}>
        <Txt variant="micro" tone="faint">{label}</Txt>
        <Txt variant="subhead" numberOfLines={lines}>{text}</Txt>
      </View>
    </View>
  );
}

/** Chat-style transcript: ROLLY on the start side with its avatar, you on the end side in ink bubbles. */
function Transcript() {
  const c = useTheme();
  const v = useVoiceSession();
  const ref = useRef<ScrollViewInstance>(null);
  return (
    <ScrollView ref={ref} style={{ flex: 1 }} contentContainerStyle={s.chat} onContentSizeChange={() => ref.current?.scrollToEnd({ animated: true })}>
      {v.captions.map((m, i) =>
        m.role === "agent" ? (
          <Animated.View key={i} entering={FadeInUp.duration(260)} style={s.agentRow}>
            <View style={s.avatar}><RollyAvatar size={34} still framed /></View>
            <View style={s.agentCol}>
              <View style={[cardStyle(c), s.bubble, s.agentBubble]}><Txt variant="body">{m.text}</Txt></View>
              {m.media?.map((it) => <MediaCard key={it.url} item={it} />)}
            </View>
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
  pipeLine: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  legal: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.sm, marginTop: -spacing.xs },
  center: { textAlign: "center" },
  stage: { flex: 1, paddingHorizontal: spacing.xxl },
  orbWrap: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 120 },
  lineBox: { height: 150, overflow: "hidden" },
  lineInner: { flex: 1, justifyContent: "flex-end" },
  idle: { gap: spacing.xl, paddingBottom: spacing.sm },
  recap: { padding: spacing.lg, gap: spacing.md },
  recapLine: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  rule: { height: StyleSheet.hairlineWidth },
  chips: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: spacing.sm },
  fadeTop: { position: "absolute", top: 0, left: 0, right: 0, height: 56 },
  controls: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.xxl, paddingTop: spacing.md, paddingBottom: spacing.sm },
  side: { width: 44 },
  chat: { padding: spacing.xl, gap: spacing.lg },
  agentRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, maxWidth: "88%" },
  avatar: { marginTop: 2 },
  agentCol: { flexShrink: 1, gap: spacing.sm },
  bubble: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.lg, borderCurve: "continuous" },
  agentBubble: { flexShrink: 1, borderTopStartRadius: 6 },
  userBubble: { alignSelf: "flex-end", maxWidth: "80%", borderTopEndRadius: 6 },
  chatBar: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.sm },
  pill: { flex: 1, height: 52, borderRadius: radius.full, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.xl },
  pillBody: { height: 52, borderRadius: radius.full, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.xl },
});
