import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { isPaired } from "../src/api";
import { ensureDirection } from "../src/i18n";

ensureDirection();

export default function Root() {
  const [paired, setPaired] = useState<boolean | null>(null);
  const segments = useSegments();
  const router = useRouter();
  useEffect(() => { void isPaired().then(setPaired); }, [segments]);
  useEffect(() => {
    if (paired === null) return;
    const onPair = segments[0] === "pair";
    if (!paired && !onPair) router.replace("/pair");
    if (paired && onPair) router.replace("/");
  }, [paired, segments, router]);
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}
