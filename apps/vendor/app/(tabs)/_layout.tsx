import { Redirect, Tabs } from "expo-router";
import { Text } from "react-native";

import { useSession } from "../../lib/session";
import { theme } from "../../lib/theme";
import { Loading } from "../../components/ui";

/**
 * Three tabs and no more.
 *
 * Everything an attendant does repeatedly is on the first one; the other two
 * exist because looking a vehicle up and running a shift are the only other
 * things they do. A fourth tab would be a feature nobody asked for competing
 * for a thumb that is holding a phone in the rain.
 */
export default function TabsLayout() {
  const { ready, user } = useSession();

  if (!ready) return <Loading />;
  if (!user) return <Redirect href="/login" />;

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.colour.surface },
        headerTintColor: theme.colour.text,
        headerTitleStyle: { fontWeight: "700" },
        tabBarStyle: {
          backgroundColor: theme.colour.surface,
          borderTopColor: theme.colour.border,
          height: 68,
          paddingBottom: 10,
          paddingTop: 6,
        },
        tabBarActiveTintColor: theme.colour.primary,
        tabBarInactiveTintColor: theme.colour.textMuted,
        tabBarLabelStyle: { fontSize: 13, fontWeight: "600" },
        sceneStyle: { backgroundColor: theme.colour.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Kerb",
          tabBarIcon: ({ color }) => <TabGlyph glyph="◉" color={color} />,
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: "Look up",
          tabBarIcon: ({ color }) => <TabGlyph glyph="⌕" color={color} />,
        }}
      />
      <Tabs.Screen
        name="today"
        options={{
          title: "Today",
          tabBarIcon: ({ color }) => <TabGlyph glyph="▤" color={color} />,
        }}
      />
    </Tabs>
  );
}

/** Glyphs rather than an icon package — three tabs do not justify the dependency. */
function TabGlyph({ glyph, color }: { glyph: string; color: string }) {
  return <Text style={{ color, fontSize: 22, lineHeight: 26 }}>{glyph}</Text>;
}
