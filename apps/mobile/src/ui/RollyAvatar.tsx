/**
 * ROLLY's avatar: a little white driver peeking over a steering wheel. It steers gently, bobs over the road, blinks,
 * and gets livelier while ROLLY talks (no mouth, by design: the eyes carry the face). The backdrop follows the local
 * clock: a sunny sky with drifting clouds by day, a violet night with a moon and twinkling stars after 19:00.
 * Everything is drawn in a 1024×1024 space and scaled to `size`. Animation runs on the UI thread (Reanimated);
 * `still` (or the OS "reduce motion" setting) renders a static frame.
 */
import { useEffect, useId, useState, type ComponentProps, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withTiming,
} from "react-native-reanimated";
import Svg, { Circle, ClipPath, Defs, Ellipse, G, LinearGradient, Mask, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import type { VoiceState } from "../voice/controller";
import { isNight, msUntilSwitch } from "./daypart";

const EASE_IN_OUT = Easing.bezier(0.45, 0, 0.55, 1);
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

const ENERGY: Record<VoiceState, number> = {
  idle: 0.4, connecting: 0.15, reconnecting: 0.15, paused: 0.2, listening: 0.5,
  user_speaking: 0.7, agent_speaking: 1, ended: 0.35, error: 0.1,
};

const SCENE = {
  day: { sky1: "#4FB6FF", sky2: "#B794F6", ring: "#1B1328", ringHi: "#3A2A55", hub: "#C084FC", shade: "#E6E9FB" },
  night: { sky1: "#2A1E48", sky2: "#0D0B13", ring: "#7C3AED", ringHi: "#A78BFA", hub: "#F5C2E7", shade: "#E4D6FB" },
} as const;

/** Wheel geometry (1024 space): the head sits behind the upper rim, the hub is near the bottom edge. */
const WHEEL = { cx: 512, cy: 880, r: 290 };
const pct = (v: number) => `${(v / 1024) * 100}%`;

function sparkle(cx: number, cy: number, s: number): string {
  const k = s * 0.12;
  return `M${cx},${cy - s} Q${cx + k},${cy - k} ${cx + s},${cy} Q${cx + k},${cy + k} ${cx},${cy + s} `
    + `Q${cx - k},${cy + k} ${cx - s},${cy} Q${cx - k},${cy - k} ${cx},${cy - s} Z`;
}

const STARS_A = [[150, 430, 16], [640, 130, 20], [900, 480, 14], [120, 640, 12]] as const;
const STARS_B = [[380, 150, 14], [930, 330, 18], [210, 520, 10], [880, 650, 12]] as const;

/** Follows the clock and re-renders right when day turns to night (and back). */
export function useNight(): boolean {
  const [night, setNight] = useState(() => isNight());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => { timer = setTimeout(() => { setNight(isNight()); arm(); }, msUntilSwitch() + 1000); };
    arm();
    return () => clearTimeout(timer);
  }, []);
  return night;
}

/** One full-size SVG layer in the 1024 space, optionally animated. */
function Layer({ size, style, children }: { size: number; style?: ComponentProps<typeof Animated.View>["style"]; children: ReactNode }) {
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]} pointerEvents="none">
      <Svg width={size} height={size} viewBox="0 0 1024 1024">{children}</Svg>
    </Animated.View>
  );
}

export function RollyAvatar({ size, state = "idle", still = false, night: forceNight }: {
  size: number; state?: VoiceState; still?: boolean; /** override the clock (previews/tests) */ night?: boolean;
}) {
  const reduced = useReducedMotion();
  const animate = !still && !reduced;
  const clockNight = useNight();
  const night = forceNight ?? clockNight;
  const sc = night ? SCENE.night : SCENE.day;
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const k = size / 1024;

  const steer = useSharedValue(0);   // -1..1, the wheel turning
  const bob = useSharedValue(0);     // 0..1, road bumps
  const blink = useSharedValue(0);   // 0..1, eyelids closing
  const twinkle = useSharedValue(0); // 0..1, stars / sparkle
  const drift = useSharedValue(0);   // 0..1, clouds crossing
  const energy = useSharedValue(ENERGY[state]);
  const dark = useSharedValue(night ? 1 : 0);

  useEffect(() => {
    if (!animate) return;
    steer.set(withRepeat(withSequence(
      withTiming(1, { duration: 1700, easing: EASE_IN_OUT }),
      withTiming(-0.6, { duration: 2100, easing: EASE_IN_OUT }),
      withTiming(0.3, { duration: 1500, easing: EASE_IN_OUT }),
      withTiming(-1, { duration: 1900, easing: EASE_IN_OUT }),
    ), -1, true));
    bob.set(withRepeat(withTiming(1, { duration: 430, easing: EASE_IN_OUT }), -1, true));
    blink.set(withRepeat(withSequence(
      withDelay(2600, withTiming(1, { duration: 80 })), withTiming(0, { duration: 120 }),
      withDelay(3400, withTiming(1, { duration: 80 })), withTiming(0, { duration: 110 }),
      withDelay(140, withTiming(1, { duration: 70 })), withTiming(0, { duration: 110 }),
    ), -1, false));
    twinkle.set(withRepeat(withTiming(1, { duration: 1400, easing: EASE_IN_OUT }), -1, true));
    drift.set(withRepeat(withTiming(1, { duration: 26000, easing: Easing.linear }), -1, false));
  }, [animate, steer, bob, blink, twinkle, drift]);

  useEffect(() => { energy.set(withTiming(ENERGY[state], { duration: 600, easing: EASE_OUT })); }, [state, energy]);
  useEffect(() => { dark.set(withTiming(night ? 1 : 0, { duration: 1200, easing: EASE_IN_OUT })); }, [night, dark]);

  const nightStyle = useAnimatedStyle(() => ({ opacity: dark.get() }));
  const dayStyle = useAnimatedStyle(() => ({ opacity: 1 - dark.get() }));
  const starsA = useAnimatedStyle(() => ({ opacity: 0.35 + 0.65 * twinkle.get() }));
  const starsB = useAnimatedStyle(() => ({ opacity: 1 - 0.65 * twinkle.get() }));
  const cloud1 = useAnimatedStyle(() => ({ transform: [{ translateX: (0.65 - 1.3 * drift.get()) * size }] }));
  const cloud2 = useAnimatedStyle(() => ({ transform: [{ translateX: (0.65 - 1.3 * ((drift.get() + 0.55) % 1)) * size }] }));
  const sparkleStyle = useAnimatedStyle(() => ({ transform: [{ scale: 0.8 + 0.25 * twinkle.get() }] }));

  const headStyle = useAnimatedStyle(() => {
    const e = energy.get();
    return {
      transform: [
        { translateY: -bob.get() * (4 + 10 * e) * k },
        { translateX: steer.get() * 6 * e * k },
        { rotate: `${steer.get() * 3 * e}deg` },
      ],
    };
  });
  const wheelStyle = useAnimatedStyle(() => {
    const e = energy.get();
    return { transform: [{ translateY: -bob.get() * 3 * e * k }, { rotate: `${steer.get() * (5 + 9 * e)}deg` }] };
  });
  const eyesStyle = useAnimatedStyle(() => ({ transform: [{ scaleY: 1 - 0.9 * blink.get() }] }));

  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.225, overflow: "hidden" }}
      accessibilityRole="image" accessibilityLabel="ROLLY" pointerEvents="none">
      {/* day sky */}
      <Layer size={size}>
        <Defs>
          <LinearGradient id={`d${uid}`} x1="0" y1="0" x2="0.6" y2="1">
            <Stop offset="0" stopColor={SCENE.day.sky1} /><Stop offset="1" stopColor={SCENE.day.sky2} />
          </LinearGradient>
          <RadialGradient id={`sun${uid}`} cx="50%" cy="50%" r="50%">
            <Stop offset="0.45" stopColor="#FFE58A" stopOpacity={0.55} /><Stop offset="1" stopColor="#FFE58A" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width={1024} height={1024} fill={`url(#d${uid})`} />
        <Circle cx={220} cy={230} r={170} fill={`url(#sun${uid})`} />
        <Circle cx={220} cy={230} r={84} fill="#FFD45A" />
      </Layer>
      <Animated.View style={[StyleSheet.absoluteFill, dayStyle]} pointerEvents="none">
        <Layer size={size} style={cloud1}><Cloud x={512} y={300} s={1} /></Layer>
        <Layer size={size} style={cloud2}><Cloud x={512} y={170} s={0.6} /></Layer>
      </Animated.View>

      {/* night sky, cross-faded in after dark */}
      <Animated.View style={[StyleSheet.absoluteFill, nightStyle]} pointerEvents="none">
        <Layer size={size}>
          <Defs>
            <LinearGradient id={`n${uid}`} x1="0" y1="0" x2="0.4" y2="1">
              <Stop offset="0" stopColor={SCENE.night.sky1} /><Stop offset="1" stopColor={SCENE.night.sky2} />
            </LinearGradient>
            <RadialGradient id={`ng${uid}`} cx="50%" cy="47%" r="45%">
              <Stop offset="0" stopColor="#7C3AED" stopOpacity={0.45} /><Stop offset="1" stopColor="#7C3AED" stopOpacity={0} />
            </RadialGradient>
            <Mask id={`m${uid}`}>
              <Rect width={1024} height={1024} fill="#fff" />
              <Circle cx={262} cy={200} r={74} fill="#000" />
            </Mask>
          </Defs>
          <Rect width={1024} height={1024} fill={`url(#n${uid})`} />
          <Rect width={1024} height={1024} fill={`url(#ng${uid})`} />
          <Circle cx={220} cy={230} r={84} fill="#FDF1C7" mask={`url(#m${uid})`} />
        </Layer>
        <Layer size={size} style={starsA}>{STARS_A.map(([x, y, s], i) => <Path key={i} d={sparkle(x, y, s)} fill="#fff" />)}</Layer>
        <Layer size={size} style={starsB}>{STARS_B.map(([x, y, s], i) => <Path key={i} d={sparkle(x, y, s)} fill="#fff" />)}</Layer>
      </Animated.View>

      <Layer size={size} style={[sparkleStyle, { transformOrigin: [800 * k, 250 * k, 0] }]}>
        <Path d={sparkle(800, 250, 58)} fill="#fff" />
      </Layer>

      {/* the driver */}
      <Animated.View style={[StyleSheet.absoluteFill, headStyle, { transformOrigin: `50% ${pct(700)}` }]} pointerEvents="none">
        <Layer size={size}>
          <Defs>
            <ClipPath id={`h${uid}`}><Ellipse cx={512} cy={505} rx={225} ry={190} /></ClipPath>
          </Defs>
          <Ellipse cx={512} cy={505} rx={225} ry={190} fill="#fff" />
          <G clipPath={`url(#h${uid})`}><Circle cx={790} cy={560} r={230} fill={sc.shade} /></G>
          <Ellipse cx={418} cy={515} rx={26} ry={14} fill="#FF8FC6" opacity={0.55} />
          <Ellipse cx={596} cy={515} rx={26} ry={14} fill="#FF8FC6" opacity={0.55} />
        </Layer>
        <Layer size={size} style={[eyesStyle, { transformOrigin: `50% ${pct(455)}` }]}>
          <Ellipse cx={453} cy={455} rx={25} ry={38} fill="#141018" transform="rotate(8 453 455)" />
          <Ellipse cx={557} cy={455} rx={25} ry={38} fill="#141018" transform="rotate(8 557 455)" />
        </Layer>
      </Animated.View>

      {/* the wheel and the hands holding it */}
      <Layer size={size} style={[wheelStyle, { transformOrigin: `${pct(WHEEL.cx)} ${pct(WHEEL.cy)}` }]}>
        <Defs>
          <LinearGradient id={`r${uid}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={sc.ringHi} /><Stop offset="1" stopColor={sc.ring} />
          </LinearGradient>
        </Defs>
        <Circle cx={WHEEL.cx} cy={WHEEL.cy} r={WHEEL.r} fill="none" stroke={`url(#r${uid})`} strokeWidth={62} />
        <Path d={`M${WHEEL.cx - WHEEL.r},${WHEEL.cy} L${WHEEL.cx + WHEEL.r},${WHEEL.cy}`} stroke={sc.ring} strokeWidth={54} strokeLinecap="round" />
        <Circle cx={WHEEL.cx} cy={WHEEL.cy} r={92} fill={sc.ring} />
        <Circle cx={WHEEL.cx} cy={WHEEL.cy} r={40} fill={sc.hub} />
        {[-42, 42].map((a) => {
          const x = WHEEL.cx + WHEEL.r * Math.sin((a * Math.PI) / 180);
          const y = WHEEL.cy - WHEEL.r * Math.cos((a * Math.PI) / 180);
          return <Ellipse key={a} cx={x} cy={y} rx={44} ry={36} fill="#fff" transform={`rotate(${a * 0.6} ${x} ${y})`} />;
        })}
      </Layer>
    </View>
  );
}

function Cloud({ x, y, s }: { x: number; y: number; s: number }) {
  return (
    <G transform={`translate(${x} ${y}) scale(${s})`} opacity={0.92}>
      <Circle cx={-70} cy={10} r={52} fill="#fff" />
      <Circle cx={5} cy={-22} r={72} fill="#fff" />
      <Circle cx={80} cy={8} r={50} fill="#fff" />
      <Rect x={-122} y={10} width={252} height={52} rx={26} fill="#fff" />
    </G>
  );
}
