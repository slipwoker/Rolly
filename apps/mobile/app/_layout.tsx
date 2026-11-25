import { Rubik_400Regular, Rubik_500Medium, Rubik_600SemiBold, Rubik_700Bold, useFonts } from "@expo-google-fonts/rubik";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { warmUp } from "../src/api";
import { ensureDirection } from "../src/i18n";
import { useTheme } from "../src/ui/theme";
import { VoiceProvider } from "../src/voice/VoiceProvider";

ensureDirection();

/** No sign-in screen: the app opens straight on Home; the phone enrolls silently on first launch. */
export default function Root() {
  const c = useTheme();
  const [fontsReady, fontError] = useFonts({ Rubik_400Regular, Rubik_500Medium, Rubik_600SemiBold, Rubik_700Bold });
  useEffect(() => { void warmUp().catch(() => { /* retried when a conversation starts; shown there if it fails */ }); }, []);
  if (!fontsReady && !fontError) return null; // the native splash stays up meanwhile
  return (
    <SafeAreaProvider>
      <VoiceProvider>
        <StatusBar style={c.dark ? "light" : "dark"} />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg } }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="voice" options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }} />
          <Stack.Screen name="progress" />
          <Stack.Screen name="personalisation" />
        </Stack>
      </VoiceProvider>
    </SafeAreaProvider>
  );
}
