import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { warmUp } from "../src/api";
import { ensureDirection } from "../src/i18n";

ensureDirection();

/** No sign-in screen: the app opens straight on the conversation; the phone enrolls silently on first launch. */
export default function Root() {
  useEffect(() => { void warmUp().catch(() => { /* retried when a conversation starts; shown there if it fails */ }); }, []);
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}
