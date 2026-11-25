import * as Device from "expo-device";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AuthError, pair } from "../src/api";
import { t } from "../src/i18n";
import { useTheme } from "../src/ui/theme";

export default function Pair() {
  const c = useTheme();
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await pair(code.trim(), Device.modelName ?? "iPhone"); router.replace("/"); }
    catch (e) { setErr(e instanceof AuthError ? t.invalidCode : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <SafeAreaView style={[s.root, { backgroundColor: c.bg }]}>
      <View style={s.box}>
        <Text style={[s.title, { color: c.text }]}>{t.pairTitle}</Text>
        <Text style={[s.hint, { color: c.dim }]}>{t.pairHint}</Text>
        <TextInput value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} placeholder="XXXXX-XXXXX"
          placeholderTextColor={c.dim} style={[s.input, { color: c.text, borderColor: c.border, backgroundColor: c.card }]} />
        {err ? <Text style={{ color: c.danger, textAlign: "center" }}>{err}</Text> : null}
        <Pressable onPress={submit} disabled={busy || code.length < 6} style={[s.btn, { backgroundColor: c.accent, opacity: busy || code.length < 6 ? 0.5 : 1 }]}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>{t.pairButton}</Text>}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, justifyContent: "center" },
  box: { paddingHorizontal: 28, gap: 16 },
  title: { fontSize: 28, fontWeight: "700", textAlign: "center" },
  hint: { fontSize: 16, textAlign: "center" },
  input: { fontSize: 24, letterSpacing: 2, textAlign: "center", borderWidth: 1, borderRadius: 12, paddingVertical: 14, writingDirection: "ltr" },
  btn: { borderRadius: 14, paddingVertical: 16, alignItems: "center" },
  btnText: { color: "#fff", fontSize: 18, fontWeight: "600" },
});
