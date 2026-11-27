/** Personalisation: how ROLLY talks to you (Hebrew addressing, language), what it remembers (correct / delete /
 *  confirm), connected services (Google calendar + mail, WhatsApp, music search), export and account deletion.
 *  Layout: one card per topic, compact rows with small icon actions, the same row shape for every service. */
import { Feather } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Alert, AppState, Linking, ScrollView, Share, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, forgetDevice } from "../src/api";
import { fill, inputAlign, isRTL, t } from "../src/i18n";
import { stateView } from "../src/whatsapp";
import { Backdrop, Card, CircleButton, IconTile, PressScale, TopBar, Txt, type IconName } from "../src/ui/components";
import { BrandIcon, type Brand } from "../src/ui/BrandIcon";
import { radius, spacing, type, useTheme } from "../src/ui/theme";

interface Me {
  preferred_name: string | null; preferred_language: "he" | "en" | null;
  addressing: { value: "masculine" | "feminine" | "plural" | null; status: "unknown" | "inferred" | "confirmed"; evidence_count: number };
  connected_services: { id: string; provider: "google" | "spotify"; status: "connected" | "not_connected" | "not_available"; account: string | null }[];
}
interface Memory { id: string; kind: string; content: string; status: "active" | "candidate"; quote: string | null }

const COLLAPSED = 6;

export default function Personalisation() {
  const c = useTheme();
  const [me, setMe] = useState<Me | null>(null);
  const [mems, setMems] = useState<Memory[]>([]);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [wa, setWa] = useState<{ available: boolean; state: string } | null>(null);
  // standing consent, per source: ROLLY may look at it before a ride (off unless the user turns it on)
  const [sig, setSig] = useState<{ calendar: boolean; mail: boolean; whatsapp: boolean }>({ calendar: false, mail: false, whatsapp: false });
  const setConsent = (source: "calendar" | "mail" | "whatsapp", enabled: boolean) => act(() => api("/v1/signals/consent", { method: "PUT", body: { source, enabled } }));
  const consentButton = (source: "calendar" | "mail" | "whatsapp") => sig[source]
    ? <SmallButton label={t.turnOff} onPress={() => setConsent(source, false)} />
    : <SmallButton label={t.turnOn} primary onPress={() => setConsent(source, true)} />;
  const load = useCallback(() => {
    api<Me>("/v1/me").then(setMe).catch(() => {});
    api<{ memories: Memory[] }>("/v1/memories").then((r) => setMems(r.memories)).catch(() => {});
    api<{ available: boolean; state: string }>("/v1/whatsapp").then(setWa).catch(() => setWa(null)); // the row only shows when the server has WhatsApp
    api<{ calendar: boolean; mail: boolean; whatsapp: boolean }>("/v1/signals/consent").then(setSig).catch(() => setSig({ calendar: false, mail: false, whatsapp: false }));
  }, []);
  useFocusEffect(load);
  // coming back from the browser after the Google consent page
  useEffect(() => { const sub = AppState.addEventListener("change", (st) => { if (st === "active") load(); }); return () => sub.remove(); }, [load]);

  const act = async (fn: () => Promise<unknown>) => { try { await fn(); } finally { load(); } };
  const confirmDanger = (title: string, fn: () => void) =>
    Alert.alert(title, t.sure, [{ text: t.cancel, style: "cancel" }, { text: t.delete, style: "destructive", onPress: fn }]);
  const connectGoogle = () => act(async () => { const r = await api<{ url: string }>("/v1/integrations/google/start", { method: "POST", body: {} }); await Linking.openURL(r.url); });
  const google = me?.connected_services.find((x) => x.provider === "google");
  const spotify = me?.connected_services.find((x) => x.provider === "spotify");
  const addrStatus = me?.addressing.status === "confirmed" ? t.addrConfirmed : me?.addressing.status === "inferred" ? t.addrInferred : t.addrUnknown;

  const active = mems.filter((m) => m.status === "active");
  const candidates = mems.filter((m) => m.status === "candidate");
  const shown = showAll ? active : active.slice(0, COLLAPSED);
  let n = 0;
  const enter = () => FadeInDown.delay(n++ * 50).duration(360);

  const MemoryRow = (m: Memory, i: number) => (
    <View key={m.id} style={[s.memRow, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border } : null]}>
      {editing?.id === m.id ? (
        <>
          <TextInput value={editing.text} onChangeText={(x) => setEditing({ id: m.id, text: x })} multiline autoFocus
            style={[type.body, s.input, { color: c.text, backgroundColor: c.surfaceAlt, textAlign: inputAlign, writingDirection: isRTL ? "rtl" : "ltr" }]} />
          <View style={s.actions}>
            <IconAction icon="check" label={t.save} tone="ink" onPress={() => act(() => api(`/v1/memories/${m.id}`, { method: "PATCH", body: { content: editing.text } })).then(() => setEditing(null))} />
            <IconAction icon="x" label={t.cancel} onPress={() => setEditing(null)} />
          </View>
        </>
      ) : (
        <>
          <Txt variant="body" style={{ flex: 1 }}>{m.content}</Txt>
          <View style={s.actions}>
            {m.status === "candidate"
              ? <IconAction icon="check" label={t.confirm} tone="accent" onPress={() => act(() => api(`/v1/memories/${m.id}/confirm`, { method: "POST", body: {} }))} />
              : <IconAction icon="edit-2" label={t.editItem} onPress={() => setEditing({ id: m.id, text: m.content })} />}
            <IconAction icon="trash-2" label={t.delete} tone="danger"
              onPress={() => confirmDanger(t.deleteItem, () => act(() => api(`/v1/memories/${m.id}`, { method: "DELETE" })))} />
          </View>
        </>
      )}
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <Backdrop />
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <TopBar start={<CircleButton icon="arrow-left" flip label={t.back} onPress={() => router.back()} />} title={t.personalisation} />
        <ScrollView contentContainerStyle={s.root} keyboardShouldPersistTaps="handled">

          <Animated.View entering={enter()}>
            <Card style={s.card}>
              <Head icon="user" title={t.profile} />
              <View style={s.field}>
                <Txt variant="label">{t.addressing}</Txt>
                <Segmented value={me?.addressing.value ?? null}
                  options={(["masculine", "feminine", "plural"] as const).map((v) => ({ value: v, label: t[v] }))}
                  onChange={(v) => act(() => api("/v1/me", { method: "PATCH", body: { addressing: v } }))} />
                <View style={s.hintRow}>
                  <Txt variant="caption" tone="dim" style={{ flex: 1 }}>{addrStatus}</Txt>
                  {me?.addressing.value ? (
                    <PressScale accessibilityRole="button" hitSlop={8} onPress={() => act(() => api("/v1/me", { method: "PATCH", body: { addressing: null } }))}>
                      <Txt variant="caption" tone="accent">{t.reset}</Txt>
                    </PressScale>
                  ) : null}
                </View>
              </View>
              <View style={[s.field, s.divided, { borderColor: c.border }]}>
                <Txt variant="label">{t.language}</Txt>
                <Segmented value={me?.preferred_language ?? null}
                  options={[{ value: "he", label: t.hebrew }, { value: "en", label: t.english }]}
                  onChange={(l) => act(() => api("/v1/me", { method: "PATCH", body: { preferred_language: l } }))} />
              </View>
            </Card>
          </Animated.View>

          <Animated.View entering={enter()}>
            <Card style={s.card}>
              <Head icon="bookmark" title={t.remembers} count={active.length} />
              {active.length ? <View>{shown.map(MemoryRow)}</View> : <Txt variant="subhead" tone="dim">{t.nothingYet}</Txt>}
              {active.length > COLLAPSED ? (
                <PressScale accessibilityRole="button" onPress={() => setShowAll((x) => !x)} style={[s.more, { backgroundColor: c.surfaceAlt }]}>
                  <Txt variant="label">{showAll ? t.showLess : fill(t.showAll, { n: String(active.length) })}</Txt>
                  <Feather name={showAll ? "chevron-up" : "chevron-down"} size={16} color={c.text} />
                </PressScale>
              ) : null}
            </Card>
          </Animated.View>

          {candidates.length ? (
            <Animated.View entering={enter()}>
              <Card style={s.card}>
                <Head icon="help-circle" title={t.unconfirmed} count={candidates.length} soft />
                <Txt variant="caption" tone="dim">{t.noSpeakerId}</Txt>
                <View>{candidates.map(MemoryRow)}</View>
              </Card>
            </Animated.View>
          ) : null}

          {google || wa?.available || spotify ? (
            <Animated.View entering={enter()}>
              <Card style={s.card}>
                <Head icon="link" title={t.services} />
                <View>
                  {[
                    google ? (
                      <ServiceRow key="g" brand="google" title={t.googleService}
                        sub={google.status === "connected" ? (google.account ?? t.connected) : t.googleWhy}
                        action={google.status === "connected"
                          ? <SmallButton label={t.disconnect} onPress={() => confirmDanger(t.disconnect, () => act(() => api("/v1/integrations/google", { method: "DELETE" })))} />
                          : google.status === "not_connected" ? <SmallButton label={t.connect} primary onPress={connectGoogle} />
                          : <Badge label={t.soon} />} />
                    ) : null,
                    google?.status === "connected" ? (
                      <ServiceRow key="gs" brand="google" title={t.signalsCalendar} sub={t.signalsCalendarWhy} action={consentButton("calendar")} />
                    ) : null,
                    google?.status === "connected" ? (
                      <ServiceRow key="gm" brand="google" title={t.signalsMail} sub={t.signalsMailWhy} action={consentButton("mail")} />
                    ) : null,
                    wa?.available ? (
                      <ServiceRow key="w" brand="whatsapp" title={t.waService}
                        sub={t[stateView(wa.state).text]} warn={stateView(wa.state).warn}
                        action={<SmallButton label={t.open} primary={wa.state !== "connected"} onPress={() => router.push("/whatsapp")} />} />
                    ) : null,
                    wa?.available && wa.state === "connected" ? (
                      <ServiceRow key="ws" brand="whatsapp" title={t.signalsWhatsapp} sub={t.signalsWhatsappWhy} action={consentButton("whatsapp")} />
                    ) : null,
                    spotify ? (
                      <ServiceRow key="s" brand="spotify" title={t.musicService} sub={t.musicWhy}
                        action={<Badge label={spotify.status === "connected" ? t.connected : t.soon} />} />
                    ) : null,
                  ].filter(Boolean).map((row, i) => (
                    <View key={i} style={i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border } : null}>{row}</View>
                  ))}
                </View>
              </Card>
            </Animated.View>
          ) : null}

          <Animated.View entering={enter()}>
            <Card style={[s.card, { paddingVertical: spacing.sm }]}>
              <ActionRow icon="download" label={t.exportData}
                onPress={async () => { const d = await api("/v1/export"); await Share.share({ message: JSON.stringify(d, null, 2) }); }} />
              <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border }} />
              <ActionRow icon="trash-2" label={t.deleteAccount} danger
                onPress={() => confirmDanger(t.deleteAccount, async () => { await api("/v1/me", { method: "DELETE" }); await forgetDevice(); load(); })} />
            </Card>
          </Animated.View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

/** Card heading: icon tile, title, optional count. */
function Head({ icon, title, count, soft }: { icon: IconName; title: string; count?: number; soft?: boolean }) {
  return (
    <View style={s.head}>
      <IconTile icon={icon} tone={soft ? "soft" : "ink"} />
      <Txt variant="headline" style={{ flex: 1 }}>{title}</Txt>
      {count ? <Txt variant="micro" tone="faint">{count}</Txt> : null}
    </View>
  );
}

/** A small round icon action (edit / delete / confirm), 36pt with a 44pt touch target. */
function IconAction({ icon, label, onPress, tone = "soft" }: { icon: IconName; label: string; onPress: () => void; tone?: "soft" | "danger" | "accent" | "ink" }) {
  const c = useTheme();
  const bg = tone === "danger" ? c.dangerSoft : tone === "accent" ? c.accentSoft : tone === "ink" ? c.ink : c.surfaceAlt;
  const fg = tone === "danger" ? c.danger : tone === "accent" ? c.accent : tone === "ink" ? c.onInk : c.text;
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4} scaleTo={0.9}
      style={[s.iconAction, { backgroundColor: bg }]}>
      <Feather name={icon} size={16} color={fg} />
    </PressScale>
  );
}

/** Two or three choices side by side, the chosen one in ink. */
function Segmented<V extends string>({ value, options, onChange }: { value: V | null; options: { value: V; label: string }[]; onChange: (v: V) => void }) {
  const c = useTheme();
  return (
    <View accessibilityRole="radiogroup" style={[s.seg, { backgroundColor: c.surfaceAlt }]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <View key={o.value} style={{ flex: 1 }}>
            <PressScale accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => onChange(o.value)} scaleTo={0.96}
              style={[s.segItem, on ? { backgroundColor: c.ink } : null]}>
              <Txt variant="label" tone={on ? "onInk" : "text"} style={{ textAlign: "center" }}>{o.label}</Txt>
            </PressScale>
          </View>
        );
      })}
    </View>
  );
}

/** One connected service: its logo, name, one or two lines of status, and a single compact action at the end. */
function ServiceRow({ brand, title, sub, action, warn }: { brand: Brand; title: string; sub: string; action: ReactNode; warn?: boolean }) {
  return (
    <View style={s.serviceRow}>
      <BrandIcon brand={brand} />
      <View style={{ flex: 1, gap: 2 }}>
        <Txt variant="bodyStrong" numberOfLines={2}>{title}</Txt>
        <Txt variant="caption" tone={warn ? "danger" : "dim"} numberOfLines={2}>{sub}</Txt>
      </View>
      {action}
    </View>
  );
}

function SmallButton({ label, onPress, primary }: { label: string; onPress: () => void; primary?: boolean }) {
  const c = useTheme();
  return (
    <PressScale accessibilityRole="button" onPress={onPress} hitSlop={6} style={[s.small, { backgroundColor: primary ? c.ink : c.surfaceAlt }]}>
      <Txt variant="micro" tone={primary ? "onInk" : "text"}>{label}</Txt>
    </PressScale>
  );
}

function Badge({ label }: { label: string }) {
  const c = useTheme();
  return <View style={[s.small, { backgroundColor: c.accentSoft }]}><Txt variant="micro" tone="accent">{label}</Txt></View>;
}

/** A full-width row action (export, delete account). */
function ActionRow({ icon, label, onPress, danger }: { icon: IconName; label: string; onPress: () => void; danger?: boolean }) {
  const c = useTheme();
  return (
    <PressScale accessibilityRole="button" onPress={onPress} scaleTo={0.98} style={s.actionRow}>
      <Feather name={icon} size={18} color={danger ? c.danger : c.text} />
      <Txt variant="bodyStrong" tone={danger ? "danger" : "text"} style={{ flex: 1 }}>{label}</Txt>
      <Feather name="chevron-right" size={18} color={c.faint} style={isRTL ? { transform: [{ scaleX: -1 }] } : undefined} />
    </PressScale>
  );
}

const s = StyleSheet.create({
  root: { paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.x4, gap: spacing.md },
  card: { gap: spacing.md },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  field: { gap: spacing.sm },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.md },
  hintRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  seg: { flexDirection: "row", padding: 4, borderRadius: radius.full, gap: 4 },
  segItem: { height: 38, borderRadius: radius.full, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.sm },
  memRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, paddingVertical: spacing.md },
  actions: { flexDirection: "row", gap: spacing.sm, paddingTop: 1 },
  iconAction: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  input: { flex: 1, borderRadius: radius.md, padding: spacing.md, minHeight: 64 },
  more: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs, height: 40, borderRadius: radius.full },
  serviceRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md, minHeight: 68 },
  small: { minWidth: 64, height: 34, paddingHorizontal: spacing.md, borderRadius: radius.full, alignItems: "center", justifyContent: "center" },
  actionRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md },
});
