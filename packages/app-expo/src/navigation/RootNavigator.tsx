import { OnboardingNavigator } from "@/components/onboarding/OnboardingNavigator";
import { MissingBookPrompt } from "@/components/shared/MissingBookPrompt";
import BadgesScreen from "@/screens/BadgesScreen";
import { BookChatScreen } from "@/screens/BookChatScreen";
import { BookDetailsScreen } from "@/screens/BookDetailsScreen";
import { FullScreenNotesScreen } from "@/screens/FullScreenNotesScreen";
import { ReaderScreen } from "@/screens/ReaderScreen";
import SkillsScreen from "@/screens/SkillsScreen";
import StatsScreen from "@/screens/StatsScreen";
import { WebDavImportBrowserScreen } from "@/screens/library/WebDavImportBrowserScreen";
import { OpdsCatalogScreen } from "@/screens/library/OpdsCatalogScreen";
import { OpdsSourceFormScreen } from "@/screens/library/OpdsSourceFormScreen";
import { OpdsSourcesScreen } from "@/screens/library/OpdsSourcesScreen";
import AISettingsScreen from "@/screens/settings/AISettingsScreen";
import AboutScreen from "@/screens/settings/AboutScreen";
import DevToolsScreen from "@/screens/DevToolsScreen";
import AppearanceSettingsScreen from "@/screens/settings/AppearanceSettingsScreen";
import FeedbackDetailScreen from "@/screens/settings/FeedbackDetailScreen";
import FeedbackScreen from "@/screens/settings/FeedbackScreen";
import FontSettingsScreen from "@/screens/settings/FontSettingsScreen";
import SyncSettingsScreen from "@/screens/settings/SyncSettingsScreen";
import TTSSettingsScreen from "@/screens/settings/TTSSettingsScreen";
import TranslationSettingsScreen from "@/screens/settings/TranslationSettingsScreen";
import VectorModelSettingsScreen from "@/screens/settings/VectorModelSettingsScreen";
import { useSettingsStore } from "@/stores";
import { useResumeStore } from "@/stores/resume-store";
import { useLibraryStore } from "@/stores/library-store";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
/**
 * RootNavigator — top-level stack matching Tauri mobile App.tsx routes exactly.
 */
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { WebDavImportSource } from "@readany/core";
import { TabNavigator } from "./TabNavigator";

export type RootStackParamList = {
  Onboarding: undefined;
  Tabs: undefined;
  DevTools: undefined;
  Reader: { bookId: string; cfi?: string; highlight?: boolean; openTTS?: boolean };
  BookDetails: { bookId: string };
  BookChat: { bookId: string; selectedText?: string; chapterTitle?: string; selectionCfi?: string };
  Stats: undefined;
  Badges: undefined;
  Skills: undefined;
  VectorModelSettings: undefined;
  AppearanceSettings: undefined;
  AISettings: undefined;
  TTSSettings: undefined;
  TranslationSettings: undefined;
  SyncSettings: undefined;
  About: undefined;
  Feedback: undefined;
  FeedbackDetail: { issueNumber: number; title: string };
  FullScreenNotes: { bookId: string };
  FontSettings: undefined;
  WebDavImportBrowser: { source: WebDavImportSource };
  OpdsSources: undefined;
  OpdsSourceForm: { sourceId?: string };
  OpdsCatalog: { sourceId: string; feedTitle?: string; feedHref?: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// 进程内只消费一次:RootNavigator(如 hot reload/二次挂载)重渲染时不再重复"直达书内"
let resumeInitialBook: string | null = null;

export function RootNavigator() {
  const { hasCompletedOnboarding, _hasHydrated } = useSettingsStore();
  const resumeHydrated = useResumeStore((s) => s._hasHydrated);
  const resumeBookId = useResumeStore((s) => s.activeReaderBookId);

  const showOnboarding = !hasCompletedOnboarding && _hasHydrated;

  // 启动恢复 = 初始路由直接进阅读器(与静读天下"一下到书内"同构:
  // 无主页闪现/无二跳;恢复的书不存在时 ReaderScreen 走既有"书籍未找到"兜底)
  const [initialResumeBook] = useState(() => {
    if (resumeInitialBook) return resumeInitialBook;
    const bookId = useResumeStore.getState().activeReaderBookId;
    if (bookId) resumeInitialBook = bookId;
    return bookId ?? null;
  });
  // 门禁只等持久化(settings/resume,毫秒级)。⚠️ 切勿等书库 isLoaded:
  // loadBooks 由 LibraryScreen mount 触发,先等它再渲染导航 = 鸡生蛋死锁。
  // 恢复直达时书库未加载的问题由 ReaderScreen 的 DB 兜底查书解决。
  if (!_hasHydrated || !resumeHydrated) {
    return <View style={s.bootstrapBg} />;
  }

  return (
    <>
      <Stack.Navigator
        screenOptions={{ headerShown: false }}
        initialRouteName={
          showOnboarding ? "Onboarding" : initialResumeBook ? "Reader" : "Tabs"
        }
      >
        {showOnboarding ? (
          <Stack.Screen name="Onboarding" component={OnboardingNavigator} />
        ) : (
          <>
            <Stack.Screen name="Tabs" component={TabNavigator} />
            <Stack.Screen
              name="DevTools"
              component={DevToolsScreen}
              options={{ animation: "slide_from_right" }}
            />
            <Stack.Screen
              name="Reader"
              component={ReaderScreen}
              initialParams={initialResumeBook ? { bookId: initialResumeBook } : undefined}
              // statusBarHidden: react-native-screens(ScreenWindowTraits)在每次屏幕切换时
              // 按 Screen.isStatusBarHidden 重放状态栏——不设则默认 false 会硬把状态栏拉回显示,
              // 抵消 JS <StatusBar hidden>。设为 true 让 traits 层保持隐藏;
              // 面板打开时的即时显示由 ReaderScreen 内 <StatusBar hidden={!chromeVisible}/> 控制。
              options={{ animation: "slide_from_right", statusBarHidden: true }}
            />
            <Stack.Screen
              name="BookDetails"
              component={BookDetailsScreen}
              options={{ animation: "slide_from_right" }}
            />
            <Stack.Screen
              name="BookChat"
              component={BookChatScreen}
              options={{ animation: "slide_from_right" }}
            />
            <Stack.Screen
              name="Stats"
              component={StatsScreen}
              options={{ animation: "slide_from_right" }}
            />
            <Stack.Screen
              name="Badges"
              component={BadgesScreen}
              options={{ animation: "slide_from_right" }}
            />
            <Stack.Screen
              name="Skills"
              component={SkillsScreen}
              options={{ animation: "slide_from_right" }}
            />
            <Stack.Screen
              name="VectorModelSettings"
              component={VectorModelSettingsScreen}
              options={{ animation: "slide_from_right" }}
            />
            <Stack.Screen name="AppearanceSettings" component={AppearanceSettingsScreen} />
            <Stack.Screen name="AISettings" component={AISettingsScreen} />
            <Stack.Screen name="TTSSettings" component={TTSSettingsScreen} />
            <Stack.Screen name="TranslationSettings" component={TranslationSettingsScreen} />
            <Stack.Screen name="SyncSettings" component={SyncSettingsScreen} />
            <Stack.Screen name="About" component={AboutScreen} />
            <Stack.Screen name="Feedback" component={FeedbackScreen} />
            <Stack.Screen
              name="FeedbackDetail"
              component={FeedbackDetailScreen}
              options={{ animation: "slide_from_right" }}
            />
            <Stack.Screen
              name="FontSettings"
              component={FontSettingsScreen}
              options={{ animation: "slide_from_right" }}
            />
            <Stack.Screen
              name="WebDavImportBrowser"
              component={WebDavImportBrowserScreen}
              options={{ animation: "slide_from_right" }}
            />
            <Stack.Screen
              name="OpdsSources"
              component={OpdsSourcesScreen}
              options={{ animation: "slide_from_right" }}
            />
            <Stack.Screen
              name="OpdsSourceForm"
              component={OpdsSourceFormScreen}
              options={{ animation: "slide_from_right" }}
            />
            <Stack.Screen
              name="OpdsCatalog"
              component={OpdsCatalogScreen}
              options={{ animation: "slide_from_right" }}
            />
            <Stack.Screen
              name="FullScreenNotes"
              component={FullScreenNotesScreen}
              options={{ animation: "slide_from_right" }}
            />
          </>
        )}
      </Stack.Navigator>
      <MissingBookPrompt />
    </>
  );
}

const s = StyleSheet.create({
  /** 门禁等待占位:与原生 splash/AnimatedSplash 同色,避免露出主题背景 */
  bootstrapBg: { flex: 1, backgroundColor: "#05042B" },
});
