/**
 * Link WhatsApp. Terms (the connection is unofficial and the number can be restricted) -> how to connect:
 *  - a link to open on a COMPUTER (emailed, or shared through the iOS share sheet): the page there shows a live QR that this
 *    phone scans. This is the reliable way: a QR cannot be scanned from the same phone's own screen, and the pairing code
 *    below does not always work (docs/WHATSAPP_GATEWAY.md);
 *  - the pairing CODE typed in WhatsApp on this phone (experimental).
 * Status, relink and disconnect live here too. Server: rolly-api /v1/whatsapp* -> apps/wa-gateway. The terms wording is a
 * draft until the legal review (decision W6): do not ship it to users outside the team before then.
 */
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, ScrollView, Share, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../src/api";
import { fill, inputAlign, t, uiLang } from "../src/i18n";
import { formatCode, isEmail, linkError, minutesLeft, normalizePhone, stateView, type LinkError } from "../src/whatsapp";
import { Backdrop, Button, Card, Chip, CircleButton, IconTile, TopBar, Txt } from "../src/ui/components";
import { radius, spacing, type, useTheme } from "../src/ui/theme";

type Step = "home" | "terms" | "method" | "email" | "wait" | "phone" | "code";
interface Status { available: boolean; state: string; web_link?: boolean; email?: boolean }
interface LinkStatus { state: string }
interface Started { state: string; code?: string; expires_in_s?: number }
interface WebLink { url?: string; sent?: boolean; expires_in_s: number }

export default function WhatsApp() {
  const c = useTheme();
  const [state, setState] = useState("unavailable");
  const [emailOk, setEmailOk] = useState(false);
  const [step, setStep] = useState<Step>("home");
  const [agreed, setAgreed] = useState(false);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null); // null = shared, not emailed
  const [code, setCode] = useState<string | null>(null);
  const [secs, setSecs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<LinkError | null>(null);
  const stepRef = useRef(step);
  stepRef.current = step;

  const load = useCallback(() => {
    api<Status>("/v1/whatsapp").then((r) => { setState(r.available ? r.state : "unavailable"); setEmailOk(Boolean(r.email)); }).catch(() => setState("unavailable"));
  }, []);
  useFocusEffect(load);

  // while waiting for a scan or a typed code: ask the server whether WhatsApp is connected now (and when the app comes back to the front)
  const check = useCallback(async () => {
    const st = stepRef.current;
    if (st !== "code" && st !== "wait") return;
    try {
      const r = await api<LinkStatus>("/v1/whatsapp/link");
      if (r.state === "connected") { setState("connected"); setStep("home"); setCode(null); }
      else if (st === "code" && r.state !== "pairing") setSecs(0); // the attempt is over on the server: the code is dead
    } catch { /* a missed poll is fine */ }
  }, []);
  useEffect(() => {
    if (step !== "code" && step !== "wait") return;
    const poll = setInterval(check, 3000);
    const tick = setInterval(() => setSecs((x) => Math.max(0, x - 1)), 1000);
    const sub = AppState.addEventListener("change", (st) => { if (st === "active") void check(); });
    return () => { clearInterval(poll); clearInterval(tick); sub.remove(); };
  }, [step, check]);

  const view = stateView(state);
  const expired = (step === "code" || step === "wait") && secs <= 0;

  const finishWait = (r: WebLink, to: string | null) => { setSentTo(to); setSecs(r.expires_in_s ?? 600); setStep("wait"); };
  const shareLink = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<WebLink>("/v1/whatsapp/web-link", { method: "POST", body: { consent: true } });
      if (!r.url) throw new Error("no link");
      await Share.share({ message: r.url });
      finishWait(r, null);
    } catch (e) { setErr(linkError(e)); } finally { setBusy(false); }
  };
  const emailLink = async () => {
    const addr = email.trim();
    if (!isEmail(addr)) { setErr("waErrEmail"); return; }
    setBusy(true); setErr(null);
    try { finishWait(await api<WebLink>("/v1/whatsapp/web-link", { method: "POST", body: { consent: true, email: addr, lang: uiLang } }), addr); }
    catch (e) { setErr(linkError(e)); } finally { setBusy(false); }
  };
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
  const leave = () => {
    // an unfinished code attempt is dropped now instead of when it times out
    if (step === "code") void api("/v1/whatsapp", { method: "DELETE" }).catch(() => {}).finally(load);
    setStep("home"); setCode(null); setErr(null);
  };
  const disconnect = () => Alert.alert(t.waDisconnectAsk, t.sure, [{ text: t.cancel, style: "cancel" },
    { text: t.disconnect, style: "destructive", onPress: () => api("/v1/whatsapp", { method: "DELETE" }).catch(() => {}).finally(load) }]);
  const startLinking = () => { setErr(null); setAgreed(false); setStep("terms"); };

  let n = 0;
  const enter = () => FadeInDown.delay(n++ * 50).duration(360);
  const errText = err ? t[err] : null;
  const inputStyle = [type.body, s.input, { color: c.text, backgroundColor: c.surfaceAlt, textAlign: inputAlign, writingDirection: "ltr" as const }];

  return (
    <View style={{ flex: 1 }}>
      <Backdrop />
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <TopBar start={<CircleButton icon="arrow-left" flip label={t.back} onPress={() => (step === "home" ? router.back() : step === "code" || step === "wait" ? leave() : setStep(step === "email" || step === "phone" ? "method" : "home"))} />} title={t.waService} />
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
                {agreed ? <View style={s.row}><Button variant="primary" label={t.waContinue} onPress={() => setStep("method")} /></View> : null}
              </Card>
            </Animated.View>
          ) : null}

          {step === "method" ? (
            <Animated.View entering={enter()}>
              <Card style={s.card}>
                <View style={s.head}><IconTile icon="monitor" /><Txt variant="headline" style={{ flex: 1 }}>{t.waMethodTitle}</Txt></View>
                <Txt variant="caption" tone="dim">{t.waMethodHint}</Txt>
                {errText ? <Txt variant="subhead" tone="danger">{errText}</Txt> : null}
                <View style={s.col}>
                  {emailOk ? <Button variant="primary" icon="mail" label={t.waByEmail} onPress={() => { setErr(null); setStep("email"); }} /> : null}
                  <Button variant={emailOk ? "secondary" : "primary"} icon="share" label={busy ? t.connecting : t.waByShare} onPress={busy ? undefined : shareLink} />
                  <Button icon="smartphone" label={t.waByCode} onPress={() => { setErr(null); setStep("phone"); }} />
                </View>
              </Card>
            </Animated.View>
          ) : null}

          {step === "email" ? (
            <Animated.View entering={enter()}>
              <Card style={s.card}>
                <View style={s.head}><IconTile icon="mail" /><Txt variant="headline" style={{ flex: 1 }}>{t.waEmailTitle}</Txt></View>
                <TextInput value={email} onChangeText={(x) => { setEmail(x); setErr(null); }} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoFocus textContentType="emailAddress"
                  placeholder={t.waEmailPlaceholder} placeholderTextColor={c.faint} accessibilityLabel={t.waEmailTitle} style={inputStyle} />
                {errText ? <Txt variant="subhead" tone="danger">{errText}</Txt> : null}
                <View style={s.row}><Button variant="primary" icon="send" label={busy ? t.connecting : t.waSendLink} onPress={busy ? undefined : emailLink} /></View>
              </Card>
            </Animated.View>
          ) : null}

          {step === "wait" ? (
            <Animated.View entering={enter()}>
              <Card style={s.card}>
                <View style={s.head}><IconTile icon="monitor" /><Txt variant="headline" style={{ flex: 1 }}>{t.waWaitTitle}</Txt></View>
                <Txt variant="subhead" tone="dim">{sentTo ? fill(t.waWaitSent, { email: sentTo }) : t.waWaitShared}</Txt>
                {[t.waWaitStep1, t.waWaitStep2, t.waWaitStep3].map((x, i) => <Txt key={i} variant="body">{`${i + 1}. ${x}`}</Txt>)}
                <Txt variant="caption" tone={expired ? "danger" : "dim"}>{expired ? t.waExpired : fill(t.waWaitLeft, { n: String(minutesLeft(secs)) })}</Txt>
                {expired ? <View style={s.row}><Button variant="primary" icon="refresh-cw" label={t.waNewLink} onPress={() => setStep("method")} /></View> : null}
              </Card>
            </Animated.View>
          ) : null}

          {step === "phone" ? (
            <Animated.View entering={enter()}>
              <Card style={s.card}>
                <View style={s.head}><IconTile icon="phone" /><Txt variant="headline" style={{ flex: 1 }}>{t.waPhoneTitle}</Txt></View>
                <TextInput value={phone} onChangeText={(x) => { setPhone(x); setErr(null); }} keyboardType="phone-pad" autoFocus textContentType="telephoneNumber"
                  placeholder={t.waPhonePlaceholder} placeholderTextColor={c.faint} accessibilityLabel={t.waPhoneTitle} style={inputStyle} />
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
  col: { gap: spacing.sm },
  input: { borderRadius: radius.md, padding: spacing.md, minHeight: 48 },
  codeBox: { borderRadius: radius.md, paddingVertical: spacing.lg, paddingHorizontal: spacing.md, alignItems: "stretch" },
});
