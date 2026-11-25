import { Tabs } from "expo-router";
import { t } from "../../src/i18n";
import { useTheme } from "../../src/ui/theme";

export default function TabsLayout() {
  const c = useTheme();
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: c.accent, tabBarStyle: { backgroundColor: c.bg, borderTopColor: c.border } }}>
      <Tabs.Screen name="index" options={{ title: t.conversation, tabBarIcon: () => null, tabBarLabelStyle: { fontSize: 15 } }} />
      <Tabs.Screen name="progress" options={{ title: t.progress, tabBarIcon: () => null, tabBarLabelStyle: { fontSize: 15 } }} />
      <Tabs.Screen name="personalisation" options={{ title: t.personalisation, tabBarIcon: () => null, tabBarLabelStyle: { fontSize: 15 } }} />
    </Tabs>
  );
}
