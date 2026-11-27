import { Rubik_400Regular, Rubik_500Medium, Rubik_600SemiBold, Rubik_700Bold, useFonts } from "@expo-google-fonts/rubik";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { warmUp } from "../src/api";
import { View } from "react-native";
import { dirStyle, ensureDirection, useUiLang } from "../src/i18n";
import { useTheme } from "../src/ui/theme";
import { VoiceProvider } from "../src/voice/VoiceProvider";

ensureDirection();
// keep the native splash (the avatar) up until the fonts are ready, so the first frame is already styled
void SplashScreen.preventAutoHideAsync().catch(() => {});

/** No sign-in screen: the app opens straight on Home; the phone enrolls silently on first launch. */
export default function Root() {
  useUiLang(); // a language switch re-renders the navigator with the new direction
  const c = useTheme();
  const [fontsReady, fontError] = useFonts({ Rubik_400Regular, Rubik_500Medium, Rubik_600SemiBold, Rubik_700Bold });
  useEffect(() => { void warmUp().catch(() => { /* retried when a conversation starts; shown there if it fails */ }); }, []);
  const ready = fontsReady || !!fontError;
  useEffect(() => { if (ready) void SplashScreen.hideAsync().catch(() => {}); }, [ready]);
  if (!ready) return null; // the native splash stays up meanwhile
  return (
    <SafeAreaProvider>
      <VoiceProvider>
        <StatusBar style={c.dark ? "light" : "dark"} />
        <View style={[dirStyle, { flex: 1 }]}>
          <Stack screenOptions={{ headerShown: false, contentStyle: [dirStyle, { backgroundColor: c.bg }] }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="progress" />
            <Stack.Screen name="personalisation" />
          </Stack>
        </View>
      </VoiceProvider>
    </SafeAreaProvider>
  );
}
