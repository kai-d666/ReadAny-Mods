/**
 * useChatWebviewBridge — Chat WebView 的 RN ↔ WebView 桥(轻量版 reader bridge)。
 *
 * RN→webview: ref.postMessage(JSON cmd) → webview 模板 window/document 'message' 事件
 *   → __chat.dispatch(cmd)。(选择 postMessage 而非 injectJavaScript:大渲染指令
 *   不经过 JS 字符串拼接/转义,避免 U+2028 与长度限制两类坑。)
 * webview→RN: postToRN(type, data) → onMessage → handleMessage switch。
 */
import { useCallback, useRef } from "react";
import type { WebView } from "react-native-webview";
import type { ChatCommand, SerializablePart } from "@/lib/chat/chat-diff";

export interface ChatWebviewCiteEvent {
  messageId: string;
  num: string;
  citation: SerializablePart | null;
}

export interface ChatWebviewCallbacks {
  onReady?: () => void;
  onPong?: () => void;
  onCite?: (detail: ChatWebviewCiteEvent) => void;
  onQuoteClick?: (text: string, cfi?: string) => void;
  onCopy?: (text: string) => void;
  onError?: (message: string) => void;
  onDebug?: (message: string) => void;
}

export function useChatWebviewBridge(callbacks: ChatWebviewCallbacks) {
  const webViewRef = useRef<WebView>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const send = useCallback((cmd: ChatCommand) => {
    webViewRef.current?.postMessage(JSON.stringify(cmd));
  }, []);

  const sendMany = useCallback(
    (cmds: ChatCommand[]) => {
      const wv = webViewRef.current;
      if (!wv) return;
      for (const cmd of cmds) {
        wv.postMessage(JSON.stringify(cmd));
      }
    },
    [],
  );

  const handleMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    let data: Record<string, any>;
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    const cb = callbacksRef.current;
    switch (data.type) {
      case "ready":
        cb.onReady?.();
        break;
      case "pong":
        cb.onPong?.();
        break;
      case "cite":
        cb.onCite?.({
          messageId: String(data.messageId ?? ""),
          num: String(data.num ?? ""),
          citation: (data.citation as SerializablePart | null) ?? null,
        });
        break;
      case "quoteClick":
        cb.onQuoteClick?.(String(data.text ?? ""), data.cfi ? String(data.cfi) : undefined);
        break;
      case "copy":
        cb.onCopy?.(String(data.text ?? ""));
        break;
      case "error":
        console.error("[ChatWebView] error:", data.message);
        cb.onError?.(String(data.message ?? ""));
        break;
      case "debug":
        console.log("[ChatWebView]", data.message);
        cb.onDebug?.(String(data.message ?? ""));
        break;
      default:
        console.log("[ChatWebView] unhandled message:", data.type);
    }
  }, []);

  return { webViewRef, send, sendMany, handleMessage };
}
