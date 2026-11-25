/**
 * ROLLY's orb: translucent violet→magenta petals that slowly turn and breathe. Its energy follows the voice state
 * (faint while connecting, calm while listening, fuller when you talk, livelier when ROLLY talks).
 * Runs entirely on the UI thread (Reanimated shared values); `still` renders a static avatar.
 */
import { useEffect, useId } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming, type SharedValue } from "react-native-reanimated";
import Svg, { Circle, Defs, Ellipse, LinearGradient, RadialGradient, Stop } from "react-native-svg";
import type { VoiceState } from "../voice/controller";
import { orb } from "./theme";

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const EASE_IN_OUT = Easing.bezier(0.45, 0, 0.55, 1);

const ENERGY: Record<VoiceState, number> = {
  idle: 0.45, connecting: 0.18, reconnecting: 0.18, paused: 0.25, listening: 0.55,
  user_speaking: 0.85, agent_speaking: 1, ended: 0.4, error: 0.15,
};

/** Each petal: start angle, spin direction/speed, ellipse radii (fractions of size), how much it squashes. */
const PETALS = [
  { a0: -30, speed: 1, rx: 0.5, ry: 0.46, amp: 0.12, from: orb.indigo, mid: orb.purple, to: orb.blush, o: 0.92 },
  { a0: 40, speed: -0.7, rx: 0.48, ry: 0.4, amp: 0.2, from: orb.violet, mid: orb.magenta, to: orb.mist, o: 0.55 },
  { a0: 120, speed: 0.55, rx: 0.47, ry: 0.36, amp: 0.24, from: orb.purple, mid: orb.pink, to: orb.mist, o: 0.45 },
  { a0: 200, speed: -1.2, rx: 0.45, ry: 0.42, amp: 0.16, from: orb.indigo, mid: orb.magenta, to: orb.blush, o: 0.4 },
  { a0: 280, speed: 0.85, rx: 0.44, ry: 0.3, amp: 0.28, from: orb.magenta, mid: orb.pink, to: orb.mist, o: 0.35 },
] as const;

export function Orb({ size, state = "idle", still = false }: { size: number; state?: VoiceState; still?: boolean }) {
  const reduced = useReducedMotion();
  const animate = !still && !reduced;
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const spin = useSharedValue(0);
  const breath = useSharedValue(0);
  const pulse = useSharedValue(0);
  const energy = useSharedValue(ENERGY[state]);

  useEffect(() => {
    if (!animate) return;
    spin.set(withRepeat(withTiming(1, { duration: 18000, easing: Easing.linear }), -1, false));
    breath.set(withRepeat(withTiming(1, { duration: 2800, easing: EASE_IN_OUT }), -1, true));
    pulse.set(withRepeat(withTiming(1, { duration: 700, easing: EASE_IN_OUT }), -1, true));
  }, [animate, spin, breath, pulse]);

  useEffect(() => { energy.set(withTiming(ENERGY[state], { duration: 700, easing: EASE_OUT })); }, [state, energy]);

  const body = useAnimatedStyle(() => {
    const e = energy.get();
    const talk = Math.max(0, e - 0.7) / 0.3; // 0..1 only while someone is talking
    return {
      opacity: 0.3 + 0.7 * Math.min(1, e * 1.5),
      transform: [{ scale: 0.8 + 0.18 * e + 0.035 * breath.get() + 0.03 * talk * pulse.get() }],
    };
  });

  return (
    <View style={{ width: size, height: size }} pointerEvents="none">
      <Animated.View style={[StyleSheet.absoluteFill, body]}>
        {/* magenta core glow */}
        <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
          <Defs>
            <RadialGradient id={`core${uid}`} cx="45%" cy="48%" r="50%">
              <Stop offset="0" stopColor={orb.pink} stopOpacity={0.75} />
              <Stop offset="0.55" stopColor={orb.magenta} stopOpacity={0.35} />
              <Stop offset="1" stopColor={orb.magenta} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#core${uid})`} />
        </Svg>
        {PETALS.map((p, i) => (
          <Petal key={i} i={i} uid={uid} size={size} p={p} spin={spin} breath={breath} pulse={pulse} energy={energy} />
        ))}
      </Animated.View>
    </View>
  );
}

function Petal({ i, uid, size, p, spin, breath, pulse, energy }: {
  i: number; uid: string; size: number; p: (typeof PETALS)[number];
  spin: SharedValue<number>; breath: SharedValue<number>; pulse: SharedValue<number>; energy: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    const e = energy.get();
    const talk = Math.max(0, e - 0.7) / 0.3;
    const w = i % 2 ? breath.get() : 1 - breath.get();
    return {
      transform: [
        { rotate: `${p.a0 + spin.get() * 360 * p.speed * (0.6 + 0.6 * e)}deg` },
        { scaleX: 1 - p.amp * w * (0.4 + e) - 0.05 * talk * pulse.get() },
        { scaleY: 1 + 0.04 * talk * (1 - pulse.get()) },
      ],
    };
  });
  const id = `p${uid}${i}`;
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      <Svg width={size} height={size}>
        <Defs>
          <LinearGradient id={id} x1="0.85" y1="0.1" x2="0.15" y2="0.95">
            <Stop offset="0" stopColor={p.from} stopOpacity={p.o} />
            <Stop offset="0.5" stopColor={p.mid} stopOpacity={p.o * 0.75} />
            <Stop offset="1" stopColor={p.to} stopOpacity={p.o * 0.2} />
          </LinearGradient>
        </Defs>
        <Ellipse cx={size / 2} cy={size / 2} rx={size * p.rx - 1} ry={size * p.ry - 1} fill={`url(#${id})`}
          stroke="#FFFFFF" strokeOpacity={size > 60 ? 0.28 : 0} strokeWidth={1} />
      </Svg>
    </Animated.View>
  );
}
