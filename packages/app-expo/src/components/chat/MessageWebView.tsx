/**
 * MessageWebView — 聊天消息列表的 WebView(Chromium)渲染装配层。
 *
 * 职责:加载 CHAT_HTML(构建期由 build-chat.js 生成,随 Metro 热更新)、
 * messages/streaming 变化 → chat-diff 计算命令 → bridge.postMessage 注入;
 * 主题/文案/占位下发;webview 事件(引用/引文/复制)回接 RN。
 * 不负责:输入栏/侧栏/header(均在 ChatScreen/BookChatScreen RN 侧)。
 */
import { useChatWebviewBridge } from "@/hooks/use-chat-webview-bridge";
import { CHAT_HTML } from "@/lib/chat/chatHtml.generated";
import {
  computeChatCommands,
  type ChatCommand,
  type DiffState,
  type StreamingStep,
} from "@/lib/chat/chat-diff";
import { useColors, withOpacity } from "@/styles/theme";
import type { CitationPart, MessageV2 } from "@readany/core/types/message";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

// 与 PartRenderer.tsx TOOL_LABEL_KEYS(253-277 行)保持一致; i18n key = toolLabels.<name>
const TOOL_LABEL_KEYS = [
  "ragSearch",
  "ragToc",
  "ragContext",
  "summarize",
  "extractEntities",
  "analyzeArguments",
  "findQuotes",
  "getAnnotations",
  "addCitation",
  "compareSections",
  "getSelection",
  "getReadingProgress",
  "getRecentHighlights",
  "getSurroundingContext",
  "listBooks",
  "searchAllHighlights",
  "searchAllNotes",
  "getReadingStats",
  "getSkills",
  "mindmap",
  "fallbackToc",
  "fallbackSearch",
  "fallbackChapterContext",
] as const;

export interface MessageWebViewProps {
  messages: MessageV2[];
  isStreaming?: boolean;
  currentStep?: "thinking" | "tool_calling" | "responding" | "idle";
  onCitationClick?: (citation: CitationPart) => void;
  onQuoteClick?: (text: string, cfi?: string) => void;
}

const MAX_RECREATE_EPOCH = 2;
const READY_TIMEOUT_MS = 8000;

export function MessageWebView({
  messages,
  isStreaming = false,
  currentStep = "idle",
  onCitationClick,
  onQuoteClick,
}: MessageWebViewProps) {
  const colors = useColors();
  const { t, i18n } = useTranslation();
  const [ready, setReady] = useState(false);
  const [epoch, setEpoch] = useState(0);

  const diffStateRef = useRef<DiffState | null>(null);
  const latestNextRef = useRef<{ messages: MessageV2[]; isStreaming: boolean; step: StreamingStep }>({
    messages: [],
    isStreaming: false,
    step: "idle",
  });

  const themeVars = useMemo(() => buildChatThemeVars(colors), [colors]);
  const localeCmd = useMemo<ChatCommand>(
    () => ({ type: "setLocale", strings: buildChatStrings(t), toolLabels: buildToolLabels(t) }),
    // 语言切换 → i18n.language 变化 → 重发(低频)
    [i18n.language, t],
  );

  const bridge = useChatWebviewBridge({
    onReady: () => {
      // ready:先注入环境(主题/占位/文案),再渲染最新快照
      const { commands, state } = computeChatCommands(null, latestNextRef.current);
      diffStateRef.current = state;
      setReady(true);
      const env: ChatCommand[] = [
        { type: "setTheme", vars: themeVars },
        { type: "setUi", bottomPad: Platform.OS === "android" ? 120 : 0 },
        { type: "setLocale", strings: buildChatStrings(t), toolLabels: buildToolLabels(t) },
        ...commands,
      ];
      for (const cmd of env) bridge.send(cmd);
    },
    onCite: ({ citation }) => {
      if (citation && onCitationClick) {
        onCitationClick(citation as unknown as CitationPart);
      }
      // ChatScreen 未接 onCitationClick:no-op(与现状一致)
    },
    onQuoteClick: (text, cfi) => onQuoteClick?.(text, cfi),
    onCopy: (text) => {
      if (text) void Clipboard.setStringAsync(text);
    },
  });
  const { send, sendMany, webViewRef } = bridge;

  // —— 数据变化 → diff 命令;ready 前只更新快照 ——
  const step: StreamingStep = currentStep;
  useEffect(() => {
    latestNextRef.current = { messages, isStreaming, step };
    if (!ready) return;
    const { commands, state } = computeChatCommands(diffStateRef.current, {
      messages,
      isStreaming,
      step,
    });
    diffStateRef.current = state;
    if (commands.length) sendMany(commands);
  }, [messages, isStreaming, step, ready, sendMany]);

  // —— 主题跟随(50ms 节流)——
  const lastThemeSentAt = useRef(0);
  useEffect(() => {
    if (!ready) return;
    const now = Date.now();
    const sendTheme = () => {
      lastThemeSentAt.current = Date.now();
      send({ type: "setTheme", vars: themeVars });
    };
    if (now - lastThemeSentAt.current < 50) {
      const timer = setTimeout(sendTheme, 50 - (now - lastThemeSentAt.current));
      return () => clearTimeout(timer);
    }
    sendTheme();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeVars, ready]);

  // —— 语言变化 → 重发 setLocale(低频,webview 重读 label)——
  useEffect(() => {
    if (!ready) return;
    send(localeCmd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localeCmd, ready]);

  // —— 白屏自愈:8s 未 ready → 重建(≤2 次,照抄 ReaderScreen 语义)——
  useEffect(() => {
    if (ready || epoch >= MAX_RECREATE_EPOCH) return;
    const timer = setTimeout(() => {
      console.warn("[MessageWebView] not ready after 8s, recreating…");
      setReady(false);
      diffStateRef.current = null;
      setEpoch((e) => e + 1);
    }, READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ready, epoch]);

  return (
    <View style={[s.container, { backgroundColor: colors.background }]}>
      {!ready && (
        <View style={s.loading} pointerEvents="none">
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        </View>
      )}
      <WebView
        key={`chat-wv-${epoch}`}
        ref={webViewRef}
        source={{ html: CHAT_HTML }}
        onMessage={(e: WebViewMessageEvent) => bridge.handleMessage(e)}
        style={s.webview}
        javaScriptEnabled
        domStorageEnabled
        cacheEnabled={false}
        originWhitelist={["*"]}
        mixedContentMode="compatibility"
        scrollEnabled
        bounces={false}
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        onError={(e) => {
          console.error("[MessageWebView] WebView error:", e.nativeEvent);
          if (epoch < MAX_RECREATE_EPOCH) {
            setReady(false);
            setEpoch((v) => v + 1);
          }
        }}
        onContentProcessDidTerminate={() => {
          console.warn("[MessageWebView] content process terminated, recreating…");
          setReady(false);
          diffStateRef.current = null;
          if (epoch < MAX_RECREATE_EPOCH) setEpoch((v) => v + 1);
        }}
      />
    </View>
  );
}

// ────────────────────────── 主题/文案构建 ──────────────────────────

function buildChatThemeVars(colors: ReturnType<typeof useColors>): Record<string, string> {
  return {
    "--bg": colors.background,
    "--fg": colors.foreground,
    "--card": colors.card,
    "--card-fg": colors.cardForeground,
    "--muted": colors.muted,
    "--muted-fg": colors.mutedForeground,
    "--border": colors.border,
    "--primary": colors.primary,
    "--primary-fg": colors.primaryForeground,
    "--destructive": colors.destructive,
    "--emerald": colors.emerald,
    "--amber": colors.amber,
    "--blue": colors.blue,
    "--muted-72": withOpacity(colors.mutedForeground, 0.72),
    "--muted-50": withOpacity(colors.mutedForeground, 0.5),
    "--card-50": withOpacity(colors.card, 0.5),
    "--primary-05": withOpacity(colors.primary, 0.05),
    "--primary-08": withOpacity(colors.primary, 0.08),
    "--primary-14": withOpacity(colors.primary, 0.14),
    "--primary-15": withOpacity(colors.primary, 0.15),
    "--destructive-04": withOpacity(colors.destructive, 0.04),
    "--destructive-05": withOpacity(colors.destructive, 0.05),
    "--destructive-10": withOpacity(colors.destructive, 0.1),
    "--destructive-35": withOpacity(colors.destructive, 0.35),
    "--amber-10": withOpacity(colors.amber, 0.1),
    "--amber-30": withOpacity(colors.amber, 0.3),
    "--spinner-fg": withOpacity(colors.blue, 0.9),
  };
}

function buildChatStrings(t: (key: string, fallback: string) => string): Record<string, string> {
  const map: Record<string, string> = {};
  const keys: Array<[string, string]> = [
    ["chatThreadContext", "会话上下文"],
    ["common.copy", "复制"],
    ["common.copied", "已复制"],
    ["common.params", "参数"],
    ["common.result", "结果"],
    ["common.retry", "重试"],
    ["streaming.aborted", "已停止生成"],
    ["streaming.toolFailed", "调用失败"],
    ["streaming.toolFailedDetail", "工具调用失败"],
    ["streaming.reasoningRunning", "思考中..."],
    ["streaming.reasoningDone", "思考完成"],
    ["streaming.thinking", "正在思考..."],
    ["streaming.toolCalling", "正在调用工具..."],
    ["streaming.responding", "正在回复..."],
    ["mindmap.mermaidChart", "Mermaid 图表"],
    ["mindmap.title", "思维导图"],
    ["mindmap.zoomHint", "双击放大 · 双指缩放 · 拖动移动"],
    ["mindmap.zoomHintMindmap", "双指缩放 · 拖动移动 · 点击节点展开/收起"],
    ["mindmap.chartLoadFailed", "图表加载失败(网络?)"],
    ["mindmap.chartError", "图表渲染失败"],
  ];
  for (const [key, fallback] of keys) {
    map[key] = t(key, fallback);
  }
  return map;
}

function buildToolLabels(t: (key: string, fallback: string) => string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const key of TOOL_LABEL_KEYS) {
    map[key] = t(`toolLabels.${key}`, key);
  }
  return map;
}

const s = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1, backgroundColor: "transparent" },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
});
