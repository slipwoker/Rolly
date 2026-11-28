/** A song, album, artist or podcast Rolly found: a tappable Spotify-style card under its reply. Tap opens it in Spotify. */
import type { MediaItem } from "@rolly/contracts";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Image, Linking, StyleSheet, View } from "react-native";
import { t } from "../i18n";
import { PressScale, Txt } from "./components";
import { radius, spacing } from "./theme";

const SPOTIFY_GREEN = "#1DB954";
/** read at render time: the app language can change while running */
const kindLabel = (k: MediaItem["kind"]): string => ({ track: t.kTrack, artist: t.kArtist, album: t.kAlbum, show: t.kShow, episode: t.kEpisode })[k];

export function MediaCard({ item }: { item: MediaItem }) {
  const open = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    // the Spotify app opens the item when installed, the web player otherwise
    Linking.openURL(item.url).catch(() => {});
  };
  return (
    <PressScale accessibilityRole="link" accessibilityLabel={`${item.title}. ${t.openInSpotify}`} onPress={open} style={s.card}>
      {item.image
        ? <Image source={{ uri: item.image }} style={[s.cover, item.kind === "artist" ? { borderRadius: 28 } : null]} accessibilityIgnoresInvertColors />
        : <View style={[s.cover, s.noCover]}><Feather name="music" size={22} color="#b3b3b3" /></View>}
      <View style={s.text}>
        <Txt variant="micro" style={{ color: SPOTIFY_GREEN }}>{kindLabel(item.kind)}</Txt>
        <Txt variant="body" numberOfLines={1} style={s.title}>{item.title}</Txt>
        {item.subtitle ? <Txt variant="caption" numberOfLines={1} style={s.sub}>{item.subtitle}</Txt> : null}
      </View>
      <View style={s.play}><Feather name="play" size={16} color="#000" /></View>
    </PressScale>
  );
}

const s = StyleSheet.create({
  // Spotify's own look (dark card, green play button) on purpose: it reads as "this opens Spotify" in both app themes
  card: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.sm, paddingEnd: spacing.md, borderRadius: radius.lg, backgroundColor: "#181818", borderCurve: "continuous", minWidth: 240 },
  cover: { width: 56, height: 56, borderRadius: 6, backgroundColor: "#282828" },
  noCover: { alignItems: "center", justifyContent: "center" },
  text: { flex: 1, minWidth: 0, gap: 1 },
  title: { color: "#fff", fontWeight: "600" },
  sub: { color: "#b3b3b3" },
  play: { width: 36, height: 36, borderRadius: 18, backgroundColor: SPOTIFY_GREEN, alignItems: "center", justifyContent: "center" },
});
