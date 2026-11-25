/**
 * ROLLY design tokens: one source of truth for colour, type, spacing, radius, shadow and motion.
 * Look: soft lavender gradients, white floating cards, ink-black primary actions, a violet→magenta orb.
 */
import { useColorScheme, type TextStyle } from "react-native";

const light = {
  bg: "#F7F6FA",
  bgTop: "#F4EFFC",
  bgBottom: "#EADFF9",
  glow: "#C9AEF2",
  glow2: "#E7D3FA",
  surface: "#FFFFFF",
  surfaceAlt: "#F3F1F7",
  card: "#FFFFFF",
  text: "#111014",
  dim: "#6E6A78",
  faint: "#A29DAE",
  border: "#E6E2EE",
  ring: "#E4E1EA",
  ink: "#0B0A0F",
  onInk: "#FFFFFF",
  accent: "#7C3AED",
  accentSoft: "#EFE7FD",
  danger: "#D92D20",
  dangerSoft: "#FDECEA",
  ok: "#12B76A",
  scrim: "rgba(17, 12, 30, 0.28)",
  shadowCard: "0 8px 24px rgba(76, 29, 149, 0.07), 0 1px 2px rgba(17, 16, 20, 0.04)",
  shadowRaised: "0 12px 32px rgba(76, 29, 149, 0.14)",
  dark: false,
};
export type Palette = typeof light;

const dark: Palette = {
  bg: "#0D0B13",
  bgTop: "#17112A",
  bgBottom: "#1D1336",
  glow: "#5B21B6",
  glow2: "#3B1C6E",
  surface: "#19161F",
  surfaceAlt: "#221E2B",
  card: "#19161F",
  text: "#F4F2FA",
  dim: "#A49FB3",
  faint: "#6F6A7E",
  border: "#2C2738",
  ring: "#2E2A38",
  ink: "#FFFFFF",
  onInk: "#0B0A0F",
  accent: "#A78BFA",
  accentSoft: "#2A2140",
  danger: "#FF6B61",
  dangerSoft: "#3A1C1C",
  ok: "#3ECF8E",
  scrim: "rgba(0, 0, 0, 0.5)",
  shadowCard: "0 8px 24px rgba(0, 0, 0, 0.35)",
  shadowRaised: "0 12px 32px rgba(0, 0, 0, 0.5)",
  dark: true,
};

export function useTheme(): Palette {
  return useColorScheme() === "dark" ? dark : light;
}

/** Orb colours are fixed in both modes: they are the brand. */
export const orb = {
  violet: "#6D28D9",
  indigo: "#5B21F5",
  purple: "#9333EA",
  magenta: "#C026D3",
  pink: "#DB2777",
  blush: "#F5C2E7",
  mist: "#FCE7F3",
};

export const spacing = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, x3: 32, x4: 48 } as const;
export const radius = { sm: 10, md: 16, lg: 22, xl: 28, full: 9999 } as const;
export const motion = { fast: 140, base: 240, slow: 420 } as const;

export const font = {
  regular: "Rubik_400Regular",
  medium: "Rubik_500Medium",
  semibold: "Rubik_600SemiBold",
  bold: "Rubik_700Bold",
} as const;

/** Named text styles. Colour is applied by <Txt> from the palette (`tone`). */
export const type = {
  display: { fontFamily: font.semibold, fontSize: 28, lineHeight: 34, letterSpacing: -0.4 },
  title: { fontFamily: font.semibold, fontSize: 22, lineHeight: 28, letterSpacing: -0.2 },
  headline: { fontFamily: font.medium, fontSize: 17, lineHeight: 22 },
  transcript: { fontFamily: font.medium, fontSize: 21, lineHeight: 30, letterSpacing: -0.1 },
  body: { fontFamily: font.regular, fontSize: 16, lineHeight: 22 },
  bodyStrong: { fontFamily: font.medium, fontSize: 16, lineHeight: 22 },
  subhead: { fontFamily: font.regular, fontSize: 15, lineHeight: 21 },
  label: { fontFamily: font.medium, fontSize: 15, lineHeight: 20 },
  caption: { fontFamily: font.regular, fontSize: 13, lineHeight: 18 },
  micro: { fontFamily: font.medium, fontSize: 12, lineHeight: 16 },
} as const satisfies Record<string, TextStyle>;
