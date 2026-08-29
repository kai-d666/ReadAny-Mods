/**
 * WebviewPerfDemoScreen — WebView 聊天排版性能验证原型(纯增量,可整文件删除)。
 *
 * 验证问题:RN 富文本原生布局是长文卡顿的根源;本页把"消息列表"整体搬进
 * WebView(Chromium 排版),真实体验 30s:预置 8000+ 字富文本、模拟流式追加、
 * 数百条消息 DOM 增长、引用 [N] 桥接。与最终迁移方案同构,但 UI 是简化 1:1。
 */
import { useTheme } from "@/styles/ThemeContext";
import { useCallback, useMemo, useState } from "react";
import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { buildWebviewPerfDemoHtml } from "./webviewPerfDemoHtml";

export function WebviewPerfDemoScreen() {
  const { colors } = useTheme();
  const nav = useNavigation();
  const [lastMsg, setLastMsg] = useState("");

  const html = useMemo(
    () =>
      buildWebviewPerfDemoHtml({
        background: colors.background,
        foreground: colors.foreground,
        card: colors.card,
        cardForeground: colors.cardForeground,
        border: colors.border,
        primary: colors.primary,
      }),
    [
      colors.background,
      colors.foreground,
      colors.card,
      colors.cardForeground,
      colors.border,
      colors.primary,
    ],
  );

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    let msg: { type?: string; index?: string; messages?: number } | null = null;
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    console.log("[WV-DEMO] bridge:", JSON.stringify(msg));
    if (msg?.type === "cite") {
      Alert.alert("引用跳转桥接 OK", `点击了引用 [${msg.index}],将执行既有跳转逻辑。`);
      return;
    }
    if (msg?.type === "ready") {
      setLastMsg(`页面就绪 · ${msg.messages} 条消息`);
    } else if (msg?.type === "more") {
      setLastMsg(`已插入 · 当前 ${msg.messages} 条消息`);
    } else if (msg?.type === "streamDone") {
      setLastMsg("流式模拟完成");
    }
  }, []);

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => nav.goBack()} activeOpacity={0.7}>
          <Text style={[s.backText, { color: colors.primary }]}>‹ 返回</Text>
        </TouchableOpacity>
        <Text style={[s.title, { color: colors.foreground }]} numberOfLines={1}>
          WebView 聊天渲染验证
        </Text>
        <View style={s.backBtn} />
      </View>

      <View style={{ flex: 1 }}>
        <WebView
          source={{ html }}
          style={s.webview}
          onMessage={onMessage}
          javaScriptEnabled
          domStorageEnabled
          cacheEnabled={false}
          originWhitelist={["*"]}
          mixedContentMode="always"
          startInLoadingState={false}
        />
      </View>

      <View style={[s.statusBar, { borderTopColor: colors.border }]}>
        <Text style={[s.statusText, { color: colors.mutedForeground }]} numberOfLines={1}>
          桥接状态:{lastMsg || "等待页面就绪…"}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: "transparent",
    minHeight: 48,
  },
  backBtn: { width: 64, justifyContent: "center" },
  backText: { fontSize: 16 },
  title: { flex: 1, textAlign: "center", fontSize: 16, fontWeight: "600" },
  webview: { flex: 1, backgroundColor: "transparent" },
  statusBar: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: 0.5,
  },
  statusText: { fontSize: 12 },
});
