/**
 * ReadAny Expo App — Root component
 *
 * Initialises platform service, i18n, and mounts navigation.
 */

// Polyfill AbortSignal.throwIfAborted — missing in Hermes, required by LangChain
if (typeof AbortSignal !== "undefined" && !AbortSignal.prototype.throwIfAborted) {
  AbortSignal.prototype.throwIfAborted = function () {
    if (this.aborted) {
      const err = this.reason ?? new Error("The operation was aborted.");
      throw err;
    }
  };
}

// Polyfill navigator.userAgent for LangChain — React Native doesn't have userAgent
if (typeof navigator !== "undefined" && !navigator.userAgent) {
  Object.defineProperty(navigator, "userAgent", {
    get: () => "ReactNative",
    configurable: true,
  });
}

import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import * as SplashScreen from "expo-splash-screen";
import * as NavigationBar from "expo-navigation-bar";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LogBox, Platform, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import { AnimatedSplash } from "@/components/splash/AnimatedSplash";
import { rnSessionEventSource } from "@/hooks";
import { setStreamingFetch } from "@readany/core/ai/llm-provider";
import { initDatabase } from "@readany/core/db/database";
import { installFeedbackLogCapture, setFeedbackWorkerUrl } from "@readany/core/feedback";
import { setSessionEventSource } from "@readany/core/hooks/use-reading-session";
import { i18nReady, initI18nLanguage } from "@readany/core/i18n";
import i18n from "@readany/core/i18n";
import { setPlatformService } from "@readany/core/services";
import { setSyncAdapter } from "@readany/core/sync";
import { Audio } from "expo-av";
import { I18nextProvider } from "react-i18next";
import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Event as TrackEvent,
  Capability,
} from "react-native-track-player";

import { FloatingTTSBubble } from "@/components/tts/FloatingTTSBubble";
import { UpdateDialog } from "@/components/update/UpdateDialog";
import { useUpdateChecker } from "@/hooks/use-update-checker";
import { navigationRef } from "@/lib/navigationRef";
import { ReaderSearchSession } from "@/lib/rag/reader-search-session";
import { preloadReaderHtmlAsset } from "@/lib/reader/reader-html-asset";
import { ResidentReaderView, residentReader, preloadResumeBook } from "@/lib/reader/resident-reader-view";
import { ExpoPlatformService } from "@/lib/platform/expo-platform-service";
import { subscribeRagSearchConfiguration } from "@/lib/rag/configure-search";
import { MobileSyncAdapter } from "@/lib/sync/sync-adapter-mobile";
import { RootNavigator } from "@/navigation/RootNavigator";
import { useLibraryStore } from "@/stores/library-store";
import { useSettingsStore } from "@/stores/settings-store";
import { ThemeProvider, useTheme } from "@/styles/ThemeContext";
import { useAutoSync } from "@readany/core/hooks/use-auto-sync";

installFeedbackLogCapture();

// iOS New-Arch + expo-dev-client cold-start: when dev-client swaps its boot
// RCTInstance for the app's instance, RCTTurboModuleManager waits up to 10s for
// every TurboModule's invalidate to return. If any module's method queue is slow
// (e.g. react-native-track-player v4, whose v4 branch is frozen and does not
// fully support RN 0.81 New Arch), the wait times out and prints RCTLogError —
// triggering a red-box. State clears correctly afterwards (see
// RCTTurboModuleManager.mm:1105), so the warning is purely cosmetic dev noise.
if (Platform.OS === "ios") {
  LogBox.ignoreLogs([/TurboModuleManager: Timed out waiting for modules to be invalidated/]);
}

const FEEDBACK_WORKER_FALLBACK = "https://feedback.readany.top";
const feedbackWorkerUrl =
  process.env.EXPO_PUBLIC_FEEDBACK_WORKER_URL?.trim() || FEEDBACK_WORKER_FALLBACK;
setFeedbackWorkerUrl(feedbackWorkerUrl);

// Keep the native splash screen visible while we bootstrap
SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * TTS 播放引擎(react-native-track-player)初始化——bootstrap 之后延迟执行,
 * 不占用冷启动首帧路径。逻辑与旧 bootstrap 内联版一致:
 * setupPlayer 单例可复用(Configuration Change 后 Activity 重启时原样成功)。
 */
async function setupTtsPlayer() {
  try {
    await TrackPlayer.setupPlayer();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already been initialized/i.test(msg)) throw e;
    console.log("[App] TrackPlayer already initialized — reusing existing native instance");
  }
  await TrackPlayer.updateOptions({
    android: {
      appKilledPlaybackBehavior: AppKilledPlaybackBehavior.ContinuePlayback,
      alwaysPauseOnInterruption: false,
    },
    stoppingAppPausesPlayback: false,
    capabilities: [
      Capability.Play,
      Capability.Pause,
      Capability.Stop,
      Capability.SkipToNext,
      Capability.SkipToPrevious,
    ],
    compactCapabilities: [Capability.Play, Capability.Pause],
    notificationCapabilities: [
      Capability.Play,
      Capability.Pause,
      Capability.Stop,
      Capability.SkipToNext,
      Capability.SkipToPrevious,
    ],
  });

  // Remote event → TTS store bridge
  const { useTTSStore: ttsStore } = await import("@/stores/tts-store");
  TrackPlayer.addEventListener(TrackEvent.RemotePlay, () => {
    ttsStore.getState().resume();
  });
  TrackPlayer.addEventListener(TrackEvent.RemotePause, () => {
    ttsStore.getState().pause();
  });
  TrackPlayer.addEventListener(TrackEvent.RemoteStop, () => {
    ttsStore.getState().stop();
  });
  TrackPlayer.addEventListener(TrackEvent.RemoteNext, () => {
    const { jumpToChunk, currentChunkIndex, totalChunks } = ttsStore.getState();
    const nextIndex = currentChunkIndex + 1;
    if (nextIndex < totalChunks) {
      jumpToChunk(nextIndex);
    }
  });
  TrackPlayer.addEventListener(TrackEvent.RemotePrevious, () => {
    const { jumpToChunk, currentChunkIndex } = ttsStore.getState();
    const prevIndex = currentChunkIndex - 1;
    if (prevIndex >= 0) {
      jumpToChunk(prevIndex);
    }
  });
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  // 开发者模式:跳过启动品牌动画(设置持久化,下次启动生效)
  const skipSplash = useSettingsStore((s) => s.devFlags.skipSplashAnimation);

  useEffect(() => {
    let unsubscribeRagSearch: (() => void) | undefined;

    async function bootstrap() {
      try {
        console.log("[App] bootstrap: register platform service");
        const platform = new ExpoPlatformService();
        setPlatformService(platform);

        // Vectorization and Reader Agent queries use separate core paths.
        // Synchronize the query-side service immediately and after settings
        // hydration/changes so remote semantic search works on mobile too.
          unsubscribeRagSearch = await subscribeRagSearchConfiguration();

        console.log("[App] bootstrap: register sync adapter");
        setSyncAdapter(new MobileSyncAdapter());

        console.log("[App] bootstrap: init database");
        await initDatabase();

        console.log("[App] bootstrap: wait i18nReady");
        await i18nReady;
        console.log("[App] i18n initialized successfully");

        console.log("[App] bootstrap: register RN session source");
        setSessionEventSource(rnSessionEventSource);

        console.log("[App] bootstrap: init language");
        await initI18nLanguage();

        console.log("[App] bootstrap: import expo/fetch");
        const { fetch: expoFetch } = await import("expo/fetch");
        setStreamingFetch(expoFetch as typeof globalThis.fetch);

        // 后台预下载 reader.html(2MB foliate bundle),dev 模式首次约 1.6s;
        // 提前下载,进阅读页时秒取,不阻塞 bootstrap
        console.log("[App] bootstrap: preload reader.html asset");
        preloadReaderHtmlAsset().catch(() => {});

        console.log("[App] bootstrap: configure audio mode");
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: true,
          shouldDuckAndroid: true,
        });

        // TrackPlayer(TTS 播放引擎)延后到首帧后初始化——setupPlayer 的原生
        // 初始化(MediaPlayer 单例 + 音频焦点)是启动期重活,冷启动不等待它;
        // TTS 的任何交互都发生在 500ms 之后,语义不变
        console.log("[App] bootstrap: schedule tts player init");
        setTimeout(() => {
          setupTtsPlayer().catch((e) => console.error("[App] setupTtsPlayer failed:", e));
        }, 500);

        console.log("[App] bootstrap: done");
        setReady(true);
        // Hide native splash now — our animated splash takes over
        await SplashScreen.hideAsync();
      } catch (error) {
        console.error("[App] bootstrap failed:", error);
        setBootError(error instanceof Error ? error.message : String(error));
        await SplashScreen.hideAsync();
      }
    }
    bootstrap();
    return () => unsubscribeRagSearch?.();
  }, []);

  // A3(柱 2):常驻阅读壳 bundle 就绪 → 立即预打开恢复书(冷启动书内直达时
  // 解析提前到导航出现前;ReaderScreen 挂载后只等渲染)
  useEffect(() => {
    return residentReader.onFoliateReady(() => {
      preloadResumeBook().catch((e) => console.warn("[App] preloadResumeBook failed:", e));
    });
  }, []);

  const handleSplashFinish = useCallback(() => {
    setSplashDone(true);
  }, []);

  if (bootError) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "#1c1c1e",
          padding: 24,
        }}
      >
        <Text
          style={{
            color: "#ffffff",
            fontSize: 18,
            fontWeight: "600",
            marginBottom: 12,
            textAlign: "center",
          }}
        >
          App failed to start
        </Text>
        <Text style={{ color: "#fca5a5", fontSize: 14, textAlign: "center" }}>{bootError}</Text>
      </View>
    );
  }

  if (!ready) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "#05042B",
        }}
      >
        {/* Background matches animated splash so transition is seamless */}
      </View>
    );
  }

  return (
    <>
      {/* 柱2:常驻阅读器壳——挂在 App 顶层、导航树之前:门禁期(!ready 占位)
          即创建 WebView,bundle 在首帧前开始执行;渲染在导航树下层,阅读激活
          时 ReaderScreen 透明背景透出书页;壳永不卸载:热路径零重建。
          书页触摸由原生 TouchForwarder(ReactRootView 拦截→直转壳 WebView)。 */}
      <ResidentReaderView />
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <AppInner />
          {!splashDone && !skipSplash && <AnimatedSplash onFinish={handleSplashFinish} />}
        </ThemeProvider>
      </I18nextProvider>
    </>
  );
}

/** 三键区域背景(跟随主题纯色)+ 三键白色图标(必须在 SafeAreaProvider 内使用) */
function NavBarScrim() {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  useEffect(() => {
    // 三键图标按主题对比度:深色底用白键,浅色底用黑键
    NavigationBar.setButtonStyleAsync(isDark ? "light" : "dark").catch(() => {});
  }, [isDark]);
  if (insets.bottom <= 0) return null;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: insets.bottom,
        backgroundColor: colors.background,
        zIndex: 9999,
      }}
    />
  );
}

function AppInner() {
  const { colors, isDark, mode } = useTheme();
  const loadBooks = useLibraryStore((s) => s.loadBooks);
  useUpdateChecker();
  useAutoSync(loadBooks);

  const navTheme = useMemo(
    () => ({
      ...(isDark ? DarkTheme : DefaultTheme),
      colors: {
        ...(isDark ? DarkTheme.colors : DefaultTheme.colors),
        background: colors.background,
        card: colors.card,
        text: colors.foreground,
        border: colors.border,
        primary: colors.primary,
      },
    }),
    [colors, isDark],
  );

  return (
    // 柱2:手势根背景改透明——书页由下层常驻壳绘制,各页面自带背景色;
    // 透明根让阅读器屏(contentStyle 透明)透出书页
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: "transparent" }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <NavigationContainer theme={navTheme} ref={navigationRef}>
            <StatusBar style={mode === "dark" ? "light" : "dark"} />
            <RootNavigator />
          </NavigationContainer>
          {/* 常驻阅读壳(柱2)承担 WebView 内核预热,1x1 blob 预热实例已删 */}
          <UpdateDialog />
          <FloatingTTSBubble />
          {/* 单常驻阅读器会话(隐藏 WebView,fallback 工具后端)——挂在 App 级
              保证永不卸载;若挂在 LibraryScreen,tab 切换/screen detach 会卸载
              WebView → fallback 工具的命令注入到死 WebView → 15s 超时 */}
          <ReaderSearchSession />
          {/* 三键区域 30% 半透明黑背景:edge-to-edge 下系统忽略导航栏背景色,内容层自绘(全局) */}
          <NavBarScrim />
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
