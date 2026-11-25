/** Personalisation: what ROLLY remembers (correct / delete / confirm), Hebrew addressing, language, connected services
 *  (placeholders), export and account deletion. */
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, ScrollView, Share, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, forgetDevice } from "../src/api";
import { isRTL, t } from "../src/i18n";
import { Backdrop, Button, Card, Chip, CircleButton, IconTile, TopBar, Txt } from "../src/ui/components";
import { radius, spacing, type, useTheme } from "../src/ui/theme";

interface Me {
  preferred_name: string | null; preferred_language: "he" | "en" | null;
  addressing: { value: "masculine" | "feminine" | "plural" | null; status: "unknown" | "inferred" | "confirmed"; evidence_count: number };
  connected_services: { id: string; status: string }[];
}
interface Memory { id: string; kind: string; content: string; status: "active" | "candidate"; quote: string | null }

export default function Personalisation() {
  const c = useTheme();
  const [me, setMe] = useState<Me | null>(null);
  const [mems, setMems] = useState<Memory[]>([]);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const load = useCallback(() => {
    api<Me>("/v1/me").then(setMe).catch(() => {});
    api<{ memories: Memory[] }>("/v1/memories").then((r) => setMems(r.memories)).catch(() => {});
  }, []);
  useFocusEffect(load);

  const act = async (fn: () => Promise<unknown>) => { try { await fn(); } finally { load(); } };
  const confirmDanger = (msg: string, fn: () => void) => Alert.alert(msg, t.sure, [{ text: t.cancel, style: "cancel" }, { text: t.delete, style: "destructive", onPress: fn }]);
  const addrStatus = me?.addressing.status === "confirmed" ? t.addrConfirmed : me?.addressing.status === "inferred" ? t.addrInferred : t.addrUnknown;

  const MemoryRow = (m: Memory, i: number) => (
    <View key={m.id} style={[s.mem, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border } : null]}>
      {editing?.id === m.id ? (
        <>
          <TextInput value={editing.text} onChangeText={(x) => setEditing({ id: m.id, text: x })} multiline autoFocus
            style={[type.body, s.input, { color: c.text, backgroundColor: c.surfaceAlt, textAlign: isRTL ? "right" : "left" }]} />
          <View style={s.row}>
            <Button variant="primary" label={t.save} onPress={() => act(() => api(`/v1/memories/${m.id}`, { method: "PATCH", body: { content: editing.text } })).then(() => setEditing(null))} />
            <Button label={t.cancel} onPress={() => setEditing(null)} />
          </View>
        </>
      ) : (
        <>
          <Txt variant="body">{m.content}</Txt>
          <View style={s.row}>
            {m.status === "candidate" ? <Button variant="primary" icon="check" label={t.confirm} onPress={() => act(() => api(`/v1/memories/${m.id}/confirm`, { method: "POST", body: {} }))} /> : null}
            <Button icon="edit-2" label={t.edit} onPress={() => setEditing({ id: m.id, text: m.content })} />
            <Button icon="trash-2" variant="danger" label={t.delete} onPress={() => act(() => api(`/v1/memories/${m.id}`, { method: "DELETE" }))} />
          </View>
        </>
      )}
    </View>
  );

  const active = mems.filter((m) => m.status === "active");
  const candidates = mems.filter((m) => m.status === "candidate");
  let n = 0;
  const enter = () => FadeInDown.delay(n++ * 50).duration(360);

  return (
    <View style={{ flex: 1 }}>
      <Backdrop />
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <TopBar start={<CircleButton icon="arrow-left" flip label={t.back} onPress={() => router.back()} />} title={t.personalisation} />
        <ScrollView contentContainerStyle={s.root} keyboardShouldPersistTaps="handled">
          <Animated.View entering={enter()}>
            <Card style={s.card}>
              <View style={s.head}><IconTile icon="user" /><Txt variant="headline">{t.addressing}</Txt></View>
              <Txt variant="subhead" tone="dim">
                {me?.addressing.value ? `${(t as Record<string, string>)[me.addressing.value]} · ` : ""}{addrStatus}
              </Txt>
              <View style={s.row}>
                {(["masculine", "feminine", "plural"] as const).map((v) => (
                  <Chip key={v} label={t[v]} selected={me?.addressing.value === v} onPress={() => act(() => api("/v1/me", { method: "PATCH", body: { addressing: v } }))} />
                ))}
                <Chip label={t.reset} onPress={() => act(() => api("/v1/me", { method: "PATCH", body: { addressing: null } }))} />
              </View>
              <View style={[s.head, { marginTop: spacing.sm }]}><IconTile icon="globe" /><Txt variant="headline">{t.language}</Txt></View>
              <View style={s.row}>
                {(["he", "en"] as const).map((l) => (
                  <Chip key={l} label={l === "he" ? t.hebrew : t.english} selected={me?.preferred_language === l}
                    onPress={() => act(() => api("/v1/me", { method: "PATCH", body: { preferred_language: l } }))} />
                ))}
              </View>
            </Card>
          </Animated.View>

          <Animated.View entering={enter()}>
            <Card style={s.card}>
              <View style={s.head}><IconTile icon="bookmark" /><Txt variant="headline" style={{ flex: 1 }}>{t.remembers}</Txt>
                {active.length ? <Txt variant="micro" tone="faint">{active.length}</Txt> : null}</View>
              {active.length ? active.map(MemoryRow) : <Txt variant="subhead" tone="dim">{t.nothingYet}</Txt>}
            </Card>
          </Animated.View>

          {candidates.length ? (
            <Animated.View entering={enter()}>
              <Card style={s.card}>
                <View style={s.head}><IconTile icon="help-circle" tone="soft" /><Txt variant="headline" style={{ flex: 1 }}>{t.unconfirmed}</Txt></View>
                <Txt variant="caption" tone="dim">{t.noSpeakerId}</Txt>
                {candidates.map(MemoryRow)}
              </Card>
            </Animated.View>
          ) : null}

          <Animated.View entering={enter()}>
            <Card style={s.card}>
              <View style={s.head}><IconTile icon="link" /><Txt variant="headline">{t.services}</Txt></View>
              {(me?.connected_services ?? []).map((x) => (
                <View key={x.id} style={s.service}>
                  <Txt variant="body" style={{ flex: 1 }}>{x.id}</Txt>
                  <View style={[s.badge, { backgroundColor: c.accentSoft }]}><Txt variant="micro" tone="accent">{t.soon}</Txt></View>
                </View>
              ))}
            </Card>
          </Animated.View>

          <Animated.View entering={enter()} style={s.col}>
            <Button icon="download" label={t.exportData} onPress={async () => { const d = await api("/v1/export"); await Share.share({ message: JSON.stringify(d, null, 2) }); }} />
            <Button icon="trash-2" variant="danger" label={t.deleteAccount} onPress={() => confirmDanger(t.deleteAccount, async () => { await api("/v1/me", { method: "DELETE" }); await forgetDevice(); load(); })} />
          </Animated.View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.x4, gap: spacing.md },
  card: { gap: spacing.md },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  mem: { paddingTop: spacing.md, gap: spacing.md },
  row: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  col: { gap: spacing.sm, marginTop: spacing.sm },
  input: { borderRadius: radius.md, padding: spacing.md, minHeight: 64 },
  service: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  badge: { paddingHorizontal: spacing.sm + 2, paddingVertical: spacing.xs, borderRadius: radius.full },
});
