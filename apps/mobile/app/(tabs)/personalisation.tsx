/** Personalisation: what ROLLY remembers (correct / delete / confirm), Hebrew addressing, language, connected services
 *  (placeholders), export and account deletion. */
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, forgetDevice } from "../../src/api";
import { t } from "../../src/i18n";
import { useTheme } from "../../src/ui/theme";

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

  const Btn = ({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) => (
    <Pressable onPress={onPress} style={[s.btn, { borderColor: danger ? c.danger : c.border }]}><Text style={{ color: danger ? c.danger : c.accent }}>{label}</Text></Pressable>
  );
  const MemoryRow = (m: Memory) => (
    <View key={m.id} style={[s.mem, { borderColor: c.border }]}>
      {editing?.id === m.id ? (
        <>
          <TextInput value={editing.text} onChangeText={(x) => setEditing({ id: m.id, text: x })} style={[s.input, { color: c.text, borderColor: c.border }]} multiline />
          <View style={s.row}>
            <Btn label={t.save} onPress={() => act(() => api(`/v1/memories/${m.id}`, { method: "PATCH", body: { content: editing.text } })).then(() => setEditing(null))} />
            <Btn label={t.cancel} onPress={() => setEditing(null)} />
          </View>
        </>
      ) : (
        <>
          <Text style={[s.text, { color: c.text }]}>{m.content}</Text>
          <View style={s.row}>
            {m.status === "candidate" ? <Btn label={t.confirm} onPress={() => act(() => api(`/v1/memories/${m.id}/confirm`, { method: "POST", body: {} }))} /> : null}
            <Btn label={t.edit} onPress={() => setEditing({ id: m.id, text: m.content })} />
            <Btn label={t.delete} danger onPress={() => act(() => api(`/v1/memories/${m.id}`, { method: "DELETE" }))} />
          </View>
        </>
      )}
    </View>
  );

  const active = mems.filter((m) => m.status === "active");
  const candidates = mems.filter((m) => m.status === "candidate");
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={s.root}>
        <Text style={[s.title, { color: c.text }]}>{t.personalisation}</Text>

        <View style={[s.card, { backgroundColor: c.card }]}>
          <Text style={[s.h, { color: c.text }]}>{t.addressing}</Text>
          <Text style={{ color: c.dim, textAlign: "left" }}>
            {me?.addressing.value ? `${(t as Record<string, string>)[me.addressing.value]} · ` : ""}{addrStatus}
          </Text>
          <View style={s.row}>
            {(["masculine", "feminine", "plural"] as const).map((v) => (
              <Pressable key={v} onPress={() => act(() => api("/v1/me", { method: "PATCH", body: { addressing: v } }))}
                style={[s.chip, { borderColor: me?.addressing.value === v ? c.accent : c.border }]}>
                <Text style={{ color: me?.addressing.value === v ? c.accent : c.dim }}>{t[v]}</Text>
              </Pressable>
            ))}
            <Pressable onPress={() => act(() => api("/v1/me", { method: "PATCH", body: { addressing: null } }))} style={[s.chip, { borderColor: c.border }]}>
              <Text style={{ color: c.dim }}>{t.reset}</Text>
            </Pressable>
          </View>
          <Text style={[s.h, { color: c.text, marginTop: 8 }]}>{t.language}</Text>
          <View style={s.row}>
            {(["he", "en"] as const).map((l) => (
              <Pressable key={l} onPress={() => act(() => api("/v1/me", { method: "PATCH", body: { preferred_language: l } }))}
                style={[s.chip, { borderColor: me?.preferred_language === l ? c.accent : c.border }]}>
                <Text style={{ color: me?.preferred_language === l ? c.accent : c.dim }}>{l === "he" ? t.hebrew : t.english}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={[s.card, { backgroundColor: c.card }]}>
          <Text style={[s.h, { color: c.text }]}>{t.remembers}</Text>
          {active.length ? active.map(MemoryRow) : <Text style={{ color: c.dim }}>{t.nothingYet}</Text>}
        </View>

        {candidates.length ? (
          <View style={[s.card, { backgroundColor: c.card }]}>
            <Text style={[s.h, { color: c.text }]}>{t.unconfirmed}</Text>
            <Text style={{ color: c.dim, fontSize: 13, textAlign: "left" }}>{t.noSpeakerId}</Text>
            {candidates.map(MemoryRow)}
          </View>
        ) : null}

        <View style={[s.card, { backgroundColor: c.card }]}>
          <Text style={[s.h, { color: c.text }]}>{t.services}</Text>
          {(me?.connected_services ?? []).map((x) => (
            <Text key={x.id} style={{ color: c.dim, textAlign: "left" }}>{x.id} · {t.soon}</Text>
          ))}
        </View>

        <View style={s.col}>
          <Btn label={t.exportData} onPress={async () => { const d = await api("/v1/export"); await Share.share({ message: JSON.stringify(d, null, 2) }); }} />
          <Btn label={t.deleteAccount} danger onPress={() => confirmDanger(t.deleteAccount, async () => { await api("/v1/me", { method: "DELETE" }); await forgetDevice(); load(); })} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  root: { padding: 18, gap: 14 },
  title: { fontSize: 28, fontWeight: "700", textAlign: "left" },
  card: { borderRadius: 14, padding: 14, gap: 10 },
  h: { fontSize: 17, fontWeight: "600", textAlign: "left" },
  text: { fontSize: 16, textAlign: "left" },
  mem: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, gap: 6 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  col: { gap: 10 },
  chip: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 6 },
  btn: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, alignItems: "center" },
  input: { borderWidth: 1, borderRadius: 8, padding: 8, fontSize: 16, textAlign: "left" },
});
