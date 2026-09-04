import { useEffect, useMemo, useState } from "react";
import { Dimensions, Keyboard, type KeyboardEvent, NativeEventEmitter, NativeModules, PixelRatio, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * 键盘位置 hook(2026-09-05 最终形态):
 * Android 数据源 = 自研 ReaderKeyboardInsets 原生模块 ——
 * InputMethodManager.getInputMethodWindowVisibleHeight()(微信同款,键盘窗口
 * 真实可见高,du 工具条+字母面板整体;读数原样采用,不做合成/缓存)。
 * iOS 暂保留旧 Keyboard 事件路径。
 */

type KeyboardState = {
  height: number;
  rawHeight: number;
  visible: boolean;
};

const ANDROID_MODULE = NativeModules.ReaderKeyboardInsets as
  | { attach: () => void }
  | undefined;

let androidEmitter: NativeEventEmitter | null = null;

export function useKeyboardInsets() {
  const safeAreaInsets = useSafeAreaInsets();
  const isAndroid = Platform.OS === "android";
  const [nativeInsets, setNativeInsets] = useState<KeyboardState>({
    height: 0,
    rawHeight: 0,
    visible: false,
  });
  const [legacyKeyboard, setLegacyKeyboard] = useState<KeyboardState>({
    height: 0,
    rawHeight: 0,
    visible: false,
  });

  // ── Android:原生键盘可见高(px → dp) ──────────────────────────────────────
  useEffect(() => {
    if (!isAndroid) return;
    ANDROID_MODULE?.attach();
    if (!androidEmitter) {
      androidEmitter = new NativeEventEmitter(NativeModules.ReaderKeyboardInsets);
    }
    const sub = androidEmitter.addListener(
      "keyboardInsetsChanged",
      (e: { bottom: number; isVisible: boolean }) => {
        const height = e.bottom / PixelRatio.get();
        setNativeInsets({ height, rawHeight: height, visible: e.isVisible });
      },
    );
    return () => sub.remove();
  }, [isAndroid]);

  // ── iOS:旧 Keyboard 事件路径(暂未切换原生) ─────────────────────────────
  useEffect(() => {
    if (isAndroid) return;
    const showEvents =
      (["keyboardWillChangeFrame", "keyboardDidChangeFrame", "keyboardDidShow"] as const);
    const hideEvents =
      (["keyboardWillHide", "keyboardDidHide"] as const);

    const updateKeyboard = (event: KeyboardEvent) => {
      const rawHeight = getRawKeyboardHeight(event);
      setLegacyKeyboard({
        height: Math.max(0, rawHeight - safeAreaInsets.bottom),
        rawHeight,
        visible: rawHeight > 0,
      });
    };
    const hideKeyboard = () => {
      setLegacyKeyboard({ height: 0, rawHeight: 0, visible: false });
    };

    const subs = [
      ...showEvents.map((ev) => Keyboard.addListener(ev, updateKeyboard)),
      ...hideEvents.map((ev) => Keyboard.addListener(ev, hideKeyboard)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [safeAreaInsets.bottom, isAndroid]);

  const keyboard = isAndroid ? nativeInsets : legacyKeyboard;

  return useMemo(
    () => ({
      bottomInset: keyboard.height,
      height: keyboard.height,
      isVisible: keyboard.visible,
      /** 键盘顶到窗口底的原始高度(Android=键盘窗口可见高,微信同款读数) */
      rawHeight: keyboard.rawHeight,
      safeAreaBottom: safeAreaInsets.bottom,
    }),
    [keyboard, safeAreaInsets.bottom],
  );
}

/** iOS 旧路径:兼容各事件度量,取最大报高 */
function getRawKeyboardHeight(event: KeyboardEvent | undefined) {
  const coordinates = event?.endCoordinates;
  const keyboardMetrics = Keyboard.metrics?.();
  const reportedHeight = coordinates?.height ?? 0;
  const metricsHeight = keyboardMetrics?.height ?? 0;
  const screenY = coordinates?.screenY;
  const windowOverlap =
    typeof screenY === "number" ? Math.max(0, Dimensions.get("window").height - screenY) : 0;
  const screenOverlap =
    reportedHeight === 0 && metricsHeight === 0 && typeof screenY === "number"
      ? Math.max(0, Dimensions.get("screen").height - screenY)
      : 0;
  return Math.max(reportedHeight, metricsHeight, windowOverlap, screenOverlap);
}
