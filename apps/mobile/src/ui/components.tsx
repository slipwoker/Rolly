/** Shared primitives. Screens compose these; colours and sizes come from theme.ts only. */
import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import type { ComponentProps, ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Switch, Text, View, type PressableProps, type StyleProp, type TextProps, type ViewStyle } from "react-native";
import Animated, { FadeInDown, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { dirStyle, isRTL } from "../i18n";
import { motion, radius, spacing, type, useTheme, type Palette } from "./theme";

export type IconName = ComponentProps<typeof Feather>["name"];

type Tone = "text" | "dim" | "faint" | "accent" | "danger" | "onInk";
/**
 * Text aligns to the reading start: right in Hebrew, left in English. "auto" resolves against the paragraph's
 * writing direction, which is set explicitly, so it does not depend on whether the RTL layout is active yet.
 */
export function Txt({ variant = "body", tone = "text", style, ...p }: TextProps & { variant?: keyof typeof type; tone?: Tone }) {
  const c = useTheme();
  return <Text {...p} style={[type[variant], { color: c[tone], textAlign: "auto", writingDirection: isRTL ? "rtl" : "ltr" }, style]} />;
}

/** Pressable with a 0.97 press-in scale (feedback on press-in, commit on release). */
export function PressScale({ style, children, scaleTo = 0.97, ...p }: Omit<PressableProps, "style"> & { style?: StyleProp<ViewStyle>; scaleTo?: number; children: ReactNode }) {
  const s = useSharedValue(1);
  const a = useAnimatedStyle(() => ({ transform: [{ scale: s.get() }] }));
  return (
    <Pressable {...p} pressRetentionOffset={16}
      onPressIn={(e) => { s.set(withTiming(scaleTo, { duration: motion.fast })); p.onPressIn?.(e); }}
      onPressOut={(e) => { s.set(withTiming(1, { duration: motion.fast })); p.onPressOut?.(e); }}>
      <Animated.View style={[a, style, p.disabled ? { opacity: 0.45 } : null]}>{children}</Animated.View>
    </Pressable>
  );
}

/** Outlined circle icon button (the header buttons in the design). */
export function CircleButton({ icon, onPress, label, size = 44, variant = "outline", flip, disabled }: {
  icon: IconName; onPress?: () => void; label: string; size?: number; variant?: "outline" | "ink" | "plain"; flip?: boolean; disabled?: boolean;
}) {
  const c = useTheme();
  const bg = variant === "ink" ? c.ink : variant === "plain" ? "transparent" : c.dark ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.55)";
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled} hitSlop={6} scaleTo={0.92}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: "center", justifyContent: "center",
        borderWidth: variant === "outline" ? StyleSheet.hairlineWidth * 2 : 0, borderColor: c.border }}>
      <Feather name={icon} size={Math.round(size * 0.42)} color={variant === "ink" ? c.onInk : c.text} style={flip && isRTL ? { transform: [{ scaleX: -1 }] } : undefined} />
    </PressScale>
  );
}

export function Card({ children, style, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  const c = useTheme();
  return <View style={[cardStyle(c), padded ? { padding: spacing.lg } : null, style]}>{children}</View>;
}
export const cardStyle = (c: Palette): ViewStyle => ({
  backgroundColor: c.card, borderRadius: radius.lg, borderCurve: "continuous", boxShadow: c.shadowCard,
  borderWidth: c.dark ? StyleSheet.hairlineWidth : 0, borderColor: c.border,
});

/** Lavender wash with two soft glows, as in the design. `plain` = the white voice screen. */
export function Backdrop({ variant = "wash" }: { variant?: "wash" | "plain" }) {
  const c = useTheme();
  if (variant === "plain") return <View style={[StyleSheet.absoluteFill, { backgroundColor: c.dark ? c.bg : "#FFFFFF" }]} />;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient colors={[c.bgTop, c.bg, c.bgBottom]} locations={[0, 0.5, 1]} style={StyleSheet.absoluteFill} />
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="g1" cx="92%" cy="8%" rx="70%" ry="38%"><Stop offset="0" stopColor={c.glow} stopOpacity={0.55} /><Stop offset="1" stopColor={c.glow} stopOpacity={0} /></RadialGradient>
          <RadialGradient id="g2" cx="0%" cy="62%" rx="65%" ry="30%"><Stop offset="0" stopColor={c.glow2} stopOpacity={0.7} /><Stop offset="1" stopColor={c.glow2} stopOpacity={0} /></RadialGradient>
          <RadialGradient id="g3" cx="70%" cy="100%" rx="80%" ry="30%"><Stop offset="0" stopColor={c.glow} stopOpacity={0.45} /><Stop offset="1" stopColor={c.glow} stopOpacity={0} /></RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#g1)" />
        <Rect width="100%" height="100%" fill="url(#g2)" />
        <Rect width="100%" height="100%" fill="url(#g3)" />
      </Svg>
    </View>
  );
}

/** Top bar: circle button, centred title, circle button. */
export function TopBar({ start, title, end }: { start?: ReactNode; title?: string; end?: ReactNode }) {
  return (
    <View style={s.topBar}>
      <View style={s.slot}>{start}</View>
      <Txt variant="headline" style={{ flex: 1, textAlign: "center" }} numberOfLines={1}>{title ?? ""}</Txt>
      <View style={[s.slot, { alignItems: "flex-end" }]}>{end}</View>
    </View>
  );
}

/** Small rounded icon tile used at the head of cards. */
export function IconTile({ icon, tone = "ink" }: { icon: IconName; tone?: "ink" | "soft" }) {
  const c = useTheme();
  return (
    <View style={{ width: 30, height: 30, borderRadius: 9, borderCurve: "continuous", alignItems: "center", justifyContent: "center", backgroundColor: tone === "ink" ? c.ink : c.accentSoft }}>
      <Feather name={icon} size={16} color={tone === "ink" ? c.onInk : c.accent} />
    </View>
  );
}

export function Chip({ label, selected, onPress, danger, size = "md" }: { label: string; selected?: boolean; onPress?: () => void; danger?: boolean; size?: "sm" | "md" }) {
  const c = useTheme();
  return (
    <PressScale accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
      style={{ paddingHorizontal: size === "sm" ? spacing.md : spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.full,
        backgroundColor: selected ? c.ink : danger ? c.dangerSoft : c.surfaceAlt }}>
      <Txt variant="label" tone={selected ? "onInk" : danger ? "danger" : "text"}>{label}</Txt>
    </PressScale>
  );
}

export function Button({ label, onPress, variant = "secondary", icon, style }: {
  label: string; onPress?: () => void; variant?: "primary" | "secondary" | "danger"; icon?: IconName; style?: StyleProp<ViewStyle>;
}) {
  const c = useTheme();
  const bg = variant === "primary" ? c.ink : variant === "danger" ? c.dangerSoft : c.surfaceAlt;
  const fg = variant === "primary" ? c.onInk : variant === "danger" ? c.danger : c.text;
  return (
    <PressScale accessibilityRole="button" onPress={onPress}
      style={[{ flexDirection: "row", gap: spacing.sm, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md, borderRadius: radius.full, backgroundColor: bg }, style]}>
      {icon ? <Feather name={icon} size={16} color={fg} /> : null}
      <Txt variant="label" style={{ color: fg }}>{label}</Txt>
    </PressScale>
  );
}

/** Bottom sheet over a dimmed scrim. */
export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  const c = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable accessibilityLabel="close" style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }]} onPress={onClose} />
      <View style={[dirStyle, { flex: 1, justifyContent: "flex-end" }]} pointerEvents="box-none">
        <Animated.View entering={FadeInDown.duration(motion.base)}
          style={[cardStyle(c), { margin: spacing.md, marginBottom: insets.bottom + spacing.md, padding: spacing.xl, gap: spacing.lg, borderRadius: radius.xl, boxShadow: c.shadowRaised }]}>
          <View style={{ alignSelf: "center", width: 36, height: 5, borderRadius: 3, backgroundColor: c.border, marginTop: -spacing.sm }} />
          {title ? <Txt variant="title">{title}</Txt> : null}
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

/** A setting that is on or off: title, an explanation under it, and the platform switch at the end. */
export function ToggleRow({ title, sub, value, onChange, disabled }: { title: string; sub?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const c = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt variant="bodyStrong">{title}</Txt>
        {sub ? <Txt variant="caption" tone="dim">{sub}</Txt> : null}
      </View>
      <Switch accessibilityLabel={title} value={value} onValueChange={onChange} disabled={disabled}
        trackColor={{ false: c.border, true: c.accent }} thumbColor="#FFFFFF" ios_backgroundColor={c.border} />
    </View>
  );
}

/** A secondary link out of the app (legal pages): small icon, label, and an "opens outside" mark. */
export function LinkRow({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const c = useTheme();
  return (
    <PressScale accessibilityRole="link" onPress={onPress} scaleTo={0.98}
      style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm, minHeight: 44 }}>
      <Feather name={icon} size={16} color={c.dim} />
      <Txt variant="subhead" tone="dim" style={{ flex: 1 }}>{label}</Txt>
      <Feather name="external-link" size={14} color={c.faint} />
    </PressScale>
  );
}

/** A tappable row with an icon tile, title, subtitle and a chevron. */
export function Row({ icon, title, sub, onPress }: { icon: IconName; title: string; sub?: string; onPress: () => void }) {
  const c = useTheme();
  return (
    <PressScale accessibilityRole="button" onPress={onPress} style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.xs }}>
      <IconTile icon={icon} />
      <View style={{ flex: 1 }}>
        <Txt variant="bodyStrong">{title}</Txt>
        {sub ? <Txt variant="caption" tone="dim">{sub}</Txt> : null}
      </View>
      <Feather name="chevron-right" size={18} color={c.faint} style={isRTL ? { transform: [{ scaleX: -1 }] } : undefined} />
    </PressScale>
  );
}

const s = StyleSheet.create({
  topBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.md, gap: spacing.md },
  slot: { width: 44 },
});
