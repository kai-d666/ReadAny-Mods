/**
 * 同步日志横幅(开发者调试,2026-09-06):
 * 顶部半透明悬浮条,显示同步状态 + 最近步骤("同步到哪一步了")。
 * 入口:开发者模式 →「同步日志横幅」开关(devFlags.syncTraceBanner)。
 */
import { useSyncStore } from "@readany/core/stores/sync-store";
import { useSettingsStore } from "@/stores";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export function SyncTraceBanner() {
  const { devFlags } = useSettingsStore();
  const trace = useSyncStore((s) => s.syncTrace);
  const status = useSyncStore((s) => s.status);
  const insets = useSafeAreaInsets();

  if (!devFlags.syncTraceBanner) return null;

  const recent = trace.slice(-8).reverse();
  const time = (ts: number) =>
    new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });

  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: insets.top + 4,
        left: 8,
        right: 8,
        zIndex: 9999,
        backgroundColor: "rgba(0,0,0,0.78)",
        borderRadius: 10,
        paddingHorizontal: 10,
        paddingVertical: 8,
      }}
    >
      <Text style={{ color: "#fff", fontWeight: "700", fontSize: 12 }}>
        同步日志 · {status}
      </Text>
      {recent.map((t, i) => (
        <Text
          key={`${t.ts}-${i}`}
          numberOfLines={1}
          style={{ color: "rgba(255,255,255,0.72)", fontSize: 10, marginTop: 1 }}
        >
          {time(t.ts)} {t.text}
        </Text>
      ))}
    </View>
  );
}
