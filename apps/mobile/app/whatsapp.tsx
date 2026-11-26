/**
 * Link WhatsApp: terms (the connection is unofficial and the number can be restricted), the user's number, then a pairing
 * CODE to type in WhatsApp (a QR cannot be scanned from the same phone). Status, relink and disconnect live here too.
 * Server side: rolly-api /v1/whatsapp -> apps/wa-gateway (docs/WHATSAPP_GATEWAY.md). The terms wording is a draft until the
 * legal review (decision W6): do not ship it to users outside the team before then.
 */
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, ScrollView, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../src/api";
import { fill, inputAlign, isRTL, t } from "../src/i18n";
import { formatCode, linkError, normalizePhone, stateView, type LinkError } from "../src/whatsapp";
import { Backdrop, Button, Card, Chip, CircleButton, IconTile, TopBar, Txt } from "../src/ui/components";
import { radius, spacing, type, useTheme } from "../src/ui/theme";

type Step = "home" | "terms" | "phone" | "code";
interface Status { available: boolean; state: string }
interface LinkStatus { state: string; link?: { code?: string; expires_in_s?: number } }
interface Started { state: string; code?: string; expires_in_s?: number }

export default function WhatsApp() {
  const c = useTheme();
  const [state, setState] = useState("unavailable");
  const [step, setStep] = useState<Step>("home");
  const [agreed, setAgreed] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [secs, setSecs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<LinkError | null>(null);
  const stepRef = useRef(step);
  stepRef.current = step;

  const load = useCallback(() => {
    api<Status>("/v1/whatsapp").then((r) => setState(r.available ? r.state : "unavailable")).catch(() => setState("unavailable"));
  }, []);
  useFocusEffect(load);

  // while the code is on screen: ask the server whether WhatsApp accepted it (also right when the app comes back to the front)
  const check = useCallback(async () => {
    if (stepRef.current !== "code") return;
    try {
      const r = await api<LinkStatus>("/v1/whatsapp/link");
      if (r.state === "connected") { setState("connected"); setStep("home"); setCode(null); }
      else if (r.state !== "pairing") setSecs(0); // the attempt is over on the server: the code is dead
    } catch { /* a missed poll is fine */ }
  }, []);
  useEffect(() => {
    if (step !== "code") return;
    const poll = setInterval(check, 3000);
    const tick = setInterval(() => setSecs((x) => Math.max(0, x - 1)), 1000);
    const sub = AppState.addEventListener("change", (st) => { if (st === "active") void check(); });
    return () => { clearInterval(poll); clearInterval(tick); sub.remove(); };
  }, [step, check]);

  const view = stateView(state);
  const expired = step === "code" && secs <= 0;

  const getCode = async () => {
    const n = normalizePhone(phone);
    if (!n) { setErr("waErrPhone"); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api<Started>("/v1/whatsapp/link", { method: "POST", body: { mode: "code", phone: n, consent: true } });
      if (!r.code) throw new Error("no code");
      setCode(formatCode(r.code)); setSecs(r.expires_in_s ?? 150); setStep("code");
    } catch (e) { setErr(linkError(e)); } finally { setBusy(false); }
  };
  const leaveCode = () => {
    // an unfinished attempt is dropped now instead of when it times out
    void api("/v1/whatsapp", { method: "DELETE" }).catch(() => {}).finally(load);
    setStep("home"); setCode(null);
  };
  const disconnect = () => Alert.alert(t.waDisconnectAsk, t.sure, [{ text: t.cancel, style: "cancel" },
    { text: t.disconnect, style: "destructive", onPress: () => api("/v1/whatsapp", { method: "DELETE" }).catch(() => {}).finally(load) }]);
  const startLinking = () => { setErr(null); setAgreed(false); setStep("terms"); };

  let n = 0;
  const enter = () => FadeInDown.delay(n++ * 50).duration(360);
  const errText = err ? t[err] : null;

  return (
    <View style={{ flex: 1 }}>
      <Backdrop />
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <TopBar start={<CircleButton icon="arrow-left" flip label={t.back} onPress={() => (step === "code" ? leaveCode() : step !== "home" ? setStep("home") : router.back())} />} title={t.waService} />
        <ScrollView contentContainerStyle={s.root} keyboardShouldPersistTaps="handled">
          {step === "home" ? (
            <Animated.View entering={enter()}>
              <Card style={s.card}>
                <View style={s.head}><IconTile icon="message-circle" /><Txt variant="headline" style={{ flex: 1 }}>{t.waService}</Txt></View>
                <Txt variant="subhead" tone={view.warn ? "danger" : "dim"}>{t[view.text]}</Txt>
                <Txt variant="caption" tone="dim">{state === "connected" || state === "reconnecting" ? t.waConnectedText : state === "needs_relink" ? t.waRelinkText : t.waWhy}</Txt>
                <View style={s.row}>
                  {view.canLink ? <Button variant="primary" icon="link" label={state === "needs_relink" ? t.waNewCode : t.connect} onPress={startLinking} /> : null}
                  {view.canUnlink ? <Button variant="danger" icon="x" label={t.disconnect} onPress={disconnect} /> : null}
                </View>
              </Card>
            </Animated.View>
          ) : null}

          {step === "terms" ? (
            <Animated.View entering={enter()}>
              <Card style={s.card}>
                <View style={s.head}><IconTile icon="alert-triangle" tone="soft" /><Txt variant="headline" style={{ flex: 1 }}>{t.waTermsTitle}</Txt></View>
                {[t.waTerm1, t.waTerm2, t.waTerm3, t.waTerm4, t.waTerm5].map((x, i) => <Txt key={i} variant="body">{`• ${x}`}</Txt>)}
                <View style={s.row}><Chip label={t.waAgree} selected={agreed} onPress={() => setAgreed(!agreed)} /></View>
                {agreed ? <View style={s.row}><Button variant="primary" label={t.waContinue} onPress={() => setStep("phone")} /></View> : null}
              </Card>
            </Animated.View>
          ) : null}

          {step === "phone" ? (
            <Animated.View entering={enter()}>
              <Card style={s.card}>
                <View style={s.head}><IconTile icon="phone" /><Txt variant="headline" style={{ flex: 1 }}>{t.waPhoneTitle}</Txt></View>
                <TextInput value={phone} onChangeText={(x) => { setPhone(x); setErr(null); }} keyboardType="phone-pad" autoFocus textContentType="telephoneNumber"
                  placeholder={t.waPhonePlaceholder} placeholderTextColor={c.faint} accessibilityLabel={t.waPhoneTitle}
                  style={[type.body, s.input, { color: c.text, backgroundColor: c.surfaceAlt, textAlign: inputAlign, writingDirection: "ltr" }]} />
                <Txt variant="caption" tone="dim">{t.waPhoneHint}</Txt>
                {errText ? <Txt variant="subhead" tone="danger">{errText}</Txt> : null}
                <View style={s.row}><Button variant="primary" icon="key" label={busy ? t.connecting : t.waGetCode} onPress={busy ? undefined : getCode} /></View>
              </Card>
            </Animated.View>
          ) : null}

          {step === "code" ? (
            <Animated.View entering={enter()}>
              <Card style={s.card}>
                <View style={s.head}><IconTile icon="key" /><Txt variant="headline" style={{ flex: 1 }}>{t.waCodeTitle}</Txt></View>
                <View style={[s.codeBox, { backgroundColor: c.surfaceAlt, opacity: expired ? 0.4 : 1 }]}>
                  <Txt variant="title" selectable style={{ letterSpacing: 4, writingDirection: "ltr", textAlign: "center" }}>{code}</Txt>
                </View>
                <Txt variant="subhead" tone={expired ? "danger" : "dim"}>{expired ? t.waExpired : fill(t.waExpires, { n: String(secs) })}</Txt>
                {[t.waStep1, t.waStep2, t.waStep3].map((x, i) => <Txt key={i} variant="body">{`${i + 1}. ${x}`}</Txt>)}
                {expired ? (
                  <>
                    <Txt variant="caption" tone="dim">{t.waBusinessNote}</Txt>
                    {errText ? <Txt variant="subhead" tone="danger">{errText}</Txt> : null}
                    <View style={s.row}><Button variant="primary" icon="refresh-cw" label={busy ? t.connecting : t.waNewCode} onPress={busy ? undefined : getCode} /></View>
                  </>
                ) : null}
              </Card>
            </Animated.View>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.x4, gap: spacing.md },
  card: { gap: spacing.md },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  row: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  input: { borderRadius: radius.md, padding: spacing.md, minHeight: 48 },
  codeBox: { borderRadius: radius.md, paddingVertical: spacing.lg, paddingHorizontal: spacing.md, alignItems: "stretch" },
});
