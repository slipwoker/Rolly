import { useColorScheme } from "react-native";
export function useTheme() {
  const dark = useColorScheme() === "dark";
  return dark
    ? { bg: "#0f1115", card: "#1a1d23", text: "#f2f3f5", dim: "#9aa0aa", accent: "#4f8cff", danger: "#ff5a5f", ok: "#3ecf8e", border: "#2a2e36" }
    : { bg: "#ffffff", card: "#f4f5f7", text: "#14161a", dim: "#5f6672", accent: "#2563eb", danger: "#d92d20", ok: "#12b76a", border: "#e3e5e9" };
}
