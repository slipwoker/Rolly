/**
 * Progress: each goal with where it stands and its next step, open tasks (tap to tick off), ideas, what moved forward,
 * recent conversations. Everything here is filled by talking; the only actions are ticking off and sharing the list.
 */
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Share, StyleSheet, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../src/api";
import { t, uiLang } from "../src/i18n";
import { Backdrop, Card, Chip, CircleButton, IconTile, PressScale, TopBar, Txt, type IconName } from "../src/ui/components";
import { spacing, useTheme } from "../src/ui/theme";

interface ListItem { id: string; kind: string; content: string; created_at: string; done_at: string | null }
interface Goal {
  id: string; content: string; status: "active" | "paused" | "achieved" | "dropped"; state_note: string | null; next_step: string | null;
  progress: { id: string; text: string; created_at: string }[];
}
interface Progress {
  goals: Goal[];
  action_items: ListItem[];
  done_items: ListItem[];
  ideas: ListItem[];
  progress: { id: string; text: string; created_at: string; goal_id: string | null }[];
  sessions: { id: string; started_at: string; summary: string | null }[];
}

const date = (s: string) => new Date(s).toLocaleDateString(uiLang === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "short" });

export default function ProgressScreen() {
  const c = useTheme();
  const [data, setData] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setBusy(true); api<Progress>("/v1/progress").then(setData).catch(() => {}).finally(() => setBusy(false)); }, []);
  useFocusEffect(load);

  /** Tick off or put back: the row moves at once, the server follows; a failure reloads the truth. */
  const setDone = (item: ListItem, done: boolean) => {
    void Haptics.selectionAsync();
    setData((d) => {
      if (!d) return d;
      const moved = { ...item, done_at: done ? new Date().toISOString() : null };
      const without = (list: ListItem[]) => list.filter((x) => x.id !== item.id);
      return done
        ? { ...d, action_items: without(d.action_items), ideas: without(d.ideas), done_items: [moved, ...d.done_items] }
        : { ...d, done_items: without(d.done_items), ...(item.kind === "idea" ? { ideas: [moved, ...d.ideas] } : { action_items: [moved, ...d.action_items] }) };
    });
    api(`/v1/memories/${item.id}/${done ? "done" : "reopen"}`, { method: "POST", body: {} }).catch(load);
  };

  const share = () => {
    if (!data) return;
    const lines = [
      ...(data.action_items.length ? [t.actionItems + ":", ...data.action_items.map((x) => `• ${x.content}`), ""] : []),
      ...(data.ideas.length ? [t.ideas + ":", ...data.ideas.map((x) => `• ${x.content}`)] : []),
    ];
    if (lines.length) void Share.share({ message: lines.join("\n").trim() });
  };

  const goals = (data?.goals ?? []).filter((g) => g.status !== "dropped");
  const unlinked = (data?.progress ?? []).filter((p) => !p.goal_id);
  const canShare = !!data && data.action_items.length + data.ideas.length > 0;
  let n = 0;
  const enter = () => FadeInDown.delay(n++ * 50).duration(360);

  return (
    <View style={{ flex: 1 }}>
      <Backdrop />
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <TopBar start={<CircleButton icon="arrow-left" flip label={t.back} onPress={() => router.back()} />} title={t.progress}
          end={canShare ? <CircleButton icon="share" label={t.shareList} onPress={share} /> : null} />
        <ScrollView contentContainerStyle={s.root} refreshControl={<RefreshControl refreshing={busy} onRefresh={load} tintColor={c.accent} />}>

          <Animated.View entering={enter()}>
            <Section icon="target" title={t.goals} count={goals.length}>
              {goals.length ? goals.map((g, i) => (
                <View key={g.id} style={[s.item, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border } : null]}>
                  <View style={s.goalHead}>
                    <Txt variant="body" style={{ flex: 1 }}>{g.content}</Txt>
                    {g.status !== "active" ? <Chip size="sm" label={g.status === "achieved" ? t.achieved : t.goalPaused} /> : null}
                  </View>
                  {g.state_note ? <Txt variant="subhead" tone="dim">{g.state_note}</Txt> : null}
                  {g.next_step && g.status === "active" ? <Txt variant="subhead" tone="accent">{t.nextStep}: {g.next_step}</Txt> : null}
                  {g.progress.slice(0, 3).map((p) => (
                    <Txt key={p.id} variant="caption" tone="faint">{date(p.created_at)} · {p.text}</Txt>
                  ))}
                </View>
              )) : <Txt variant="subhead" tone="dim">{t.goalsEmpty}</Txt>}
            </Section>
          </Animated.View>

          <Animated.View entering={enter()}>
            <Section icon="check-square" title={t.actionItems} count={data?.action_items.length ?? 0}>
              {data?.action_items.length ? data.action_items.map((x, i) => <TickRow key={x.id} item={x} first={i === 0} onToggle={() => setDone(x, true)} />)
                : <Txt variant="subhead" tone="dim">{t.noTasks}</Txt>}
            </Section>
          </Animated.View>

          {data?.ideas.length ? (
            <Animated.View entering={enter()}>
              <Section icon="zap" title={t.ideas} count={data.ideas.length}>
                {data.ideas.map((x, i) => <TickRow key={x.id} item={x} first={i === 0} onToggle={() => setDone(x, true)} />)}
              </Section>
            </Animated.View>
          ) : null}

          {data?.done_items.length ? (
            <Animated.View entering={enter()}>
              <Section icon="check-circle" title={t.doneItems} count={data.done_items.length}>
                {data.done_items.map((x, i) => <TickRow key={x.id} item={x} first={i === 0} done onToggle={() => setDone(x, false)} />)}
              </Section>
            </Animated.View>
          ) : null}

          {unlinked.length ? (
            <Animated.View entering={enter()}>
              <Section icon="trending-up" title={t.moved} count={unlinked.length}>
                {unlinked.slice(0, 12).map((p, i) => (
                  <View key={p.id} style={[s.item, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border } : null]}>
                    <Txt variant="body">{p.text}</Txt>
                    <Txt variant="caption" tone="faint">{date(p.created_at)}</Txt>
                  </View>
                ))}
              </Section>
            </Animated.View>
          ) : null}

          <Animated.View entering={enter()}>
            <Section icon="clock" title={t.recent} count={data?.sessions.length ?? 0}>
              {data?.sessions.length ? data.sessions.slice(0, 8).map((x, i) => (
                <View key={x.id} style={[s.item, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border } : null]}>
                  <Txt variant="body">{x.summary ?? "—"}</Txt>
                  <Txt variant="caption" tone="faint">{date(x.started_at)}</Txt>
                </View>
              )) : <Txt variant="subhead" tone="dim">{t.nothingYet}</Txt>}
            </Section>
          </Animated.View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function Section({ icon, title, count, children }: { icon: IconName; title: string; count: number; children: React.ReactNode }) {
  return (
    <Card style={s.card}>
      <View style={s.head}>
        <IconTile icon={icon} />
        <Txt variant="headline" style={{ flex: 1 }}>{title}</Txt>
        {count ? <Txt variant="micro" tone="faint">{count}</Txt> : null}
      </View>
      {children}
    </Card>
  );
}

/** A task or idea with a tick circle. The whole row is the target (44pt high at least). */
function TickRow({ item, first, done, onToggle }: { item: ListItem; first: boolean; done?: boolean; onToggle: () => void }) {
  const c = useTheme();
  return (
    <PressScale accessibilityRole="checkbox" accessibilityState={{ checked: !!done }} accessibilityLabel={item.content} onPress={onToggle} scaleTo={0.98}
      style={[s.tick, first ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border }]}>
      <Feather name={done ? "check-circle" : "circle"} size={22} color={done ? c.ok : c.faint} />
      <View style={{ flex: 1, gap: spacing.xxs }}>
        <Txt variant="body" tone={done ? "faint" : "text"} style={done ? { textDecorationLine: "line-through" } : null}>{item.content}</Txt>
        <Txt variant="caption" tone="faint">{date(done && item.done_at ? item.done_at : item.created_at)}</Txt>
      </View>
    </PressScale>
  );
}

const s = StyleSheet.create({
  root: { paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.x4, gap: spacing.md },
  card: { gap: spacing.md },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  item: { gap: spacing.xxs, paddingTop: spacing.md },
  goalHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  tick: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 44, paddingTop: spacing.md },
});
