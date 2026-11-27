/** Voice-specific pieces: the ringed mic button and a small live waveform. */
import { Feather } from "@expo/vector-icons";
import { useEffect } from "react";
import { View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming, type SharedValue } from "react-native-reanimated";
import { PressScale, type IconName } from "./components";
import { useTheme } from "./theme";

/** Black mic button inside a soft grey ring; the ring ripples outward while `live`. */
export function MicButton({ icon, onPress, live, label }: { icon: IconName; onPress: () => void; live: boolean; label: string }) {
  const c = useTheme();
  const reduced = useReducedMotion();
  const r = useSharedValue(0);
  useEffect(() => {
    if (live && !reduced) r.set(withRepeat(withTiming(1, { duration: 1600, easing: Easing.bezier(0.23, 1, 0.32, 1) }), -1, false));
    else r.set(withTiming(0, { duration: 200 }));
  }, [live, reduced, r]);
  const ripple = useAnimatedStyle(() => ({ opacity: 0.55 * (1 - r.get()), transform: [{ scale: 1 + 0.35 * r.get() }] }));
  return (
    <View style={{ width: 96, height: 96, alignItems: "center", justifyContent: "center" }}>
      <Animated.View pointerEvents="none" style={[{ position: "absolute", width: 84, height: 84, borderRadius: 42, backgroundColor: c.ring }, ripple]} />
      <PressScale accessibilityRole="button" accessibilityLabel={label} onPress={onPress} scaleTo={0.93}
        style={{ width: 84, height: 84, borderRadius: 42, backgroundColor: c.ring, alignItems: "center", justifyContent: "center", boxShadow: "inset 0 2px 6px rgba(0,0,0,0.08)" }}>
        <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: c.ink, alignItems: "center", justifyContent: "center", boxShadow: "0 6px 16px rgba(0,0,0,0.25)" }}>
          <Feather name={icon} size={22} color={c.onInk} />
        </View>
      </PressScale>
    </View>
  );
}

const BARS = 22;
/** Equaliser bars; `level` 0 = flat, 1 = lively. */
export function Waveform({ level, color, height = 22 }: { level: number; color: string; height?: number }) {
  const reduced = useReducedMotion();
  const t = useSharedValue(0);
  const lv = useSharedValue(level);
  useEffect(() => { if (!reduced) t.set(withRepeat(withTiming(1, { duration: 1400, easing: Easing.linear }), -1, false)); }, [reduced, t]);
  useEffect(() => { lv.set(withTiming(level, { duration: 300 })); }, [level, lv]);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3, height }}>
      {Array.from({ length: BARS }, (_, i) => <Bar key={i} i={i} t={t} lv={lv} color={color} height={height} />)}
    </View>
  );
}
function Bar({ i, t, lv, color, height }: { i: number; t: SharedValue<number>; lv: SharedValue<number>; color: string; height: number }) {
  const st = useAnimatedStyle(() => {
    const phase = t.get() * Math.PI * 2;
    const wave = Math.abs(Math.sin(phase * (1 + (i % 3) * 0.5) + i * 0.9)) * (0.55 + 0.45 * Math.abs(Math.sin(i * 1.7)));
    return { transform: [{ scaleY: 0.3 + 0.7 * wave * lv.get() }] };  // never flatter than a short rounded bar
  });
  return <Animated.View style={[{ width: 3, height, borderRadius: 2, backgroundColor: color }, st]} />;
}
