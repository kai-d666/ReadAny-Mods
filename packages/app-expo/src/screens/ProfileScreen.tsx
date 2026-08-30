import {
  ChevronRightIcon,
  CloudIcon,
  CpuIcon,
  DatabaseIcon,
  HelpCircleIcon,
  InfoIcon,
  LanguagesIcon,
  MessageSquareIcon,
  PaletteIcon,
  PuzzleIcon,
  Trash2Icon,
  TypeIcon,
  Volume2Icon,
} from "@/components/ui/Icon";
import { SyncButton } from "@/components/ui/SyncButton";
import { clearMobileRuntimeCache, formatCacheSize } from "@/lib/platform/mobile-cache";
import { stopTTSPreview } from "@/lib/platform/tts-preview";
import {
  mergeCurrentSessionIntoDailyStats,
  mergeCurrentSessionIntoOverallStats,
} from "@/lib/stats/live-reading-stats";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import { TabActiveContext } from "@/navigation/TabNavigator";
import { GESTURE_DEBUG_LABELS, useGestureDebugStore } from "@/stores/gesture-debug-store";
import { useReadingSessionStore, useTTSStore } from "@/stores";
import {
  type ThemeColors,
  fontSize,
  fontWeight,
  radius,
  useColors,
  withOpacity,
} from "@/styles/theme";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { refreshAndCountUnreadFeedback } from "@readany/core/feedback";
import { readingStatsService } from "@readany/core/stats";
import type { DailyStats, OverallStats } from "@readany/core/stats";
import { eventBus } from "@readany/core/utils/event-bus";
import Constants from "expo-constants";
/**
 * ProfileScreen — matching Tauri mobile ProfilePage exactly.
 * Features: 阅读统计面板(顶部下拉滑出:统计卡+热力图)、设置菜单(general/skills/about)。
 */
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type Nav = NativeStackNavigationProp<RootStackParamList>;
type ProfileMenuIcon = (props: {
  size?: number;
  color?: string;
  strokeWidth?: number;
}) => React.ReactNode;
type ProfileMenuRoute = Extract<
  keyof RootStackParamList,
  | "AppearanceSettings"
  | "FontSettings"
  | "SyncSettings"
  | "AISettings"
  | "TTSSettings"
  | "TranslationSettings"
  | "Skills"
  | "VectorModelSettings"
  | "Feedback"
  | "About"
>;
type ProfileMenuItem =
  | {
      icon: ProfileMenuIcon;
      label: string;
      route: ProfileMenuRoute;
      showDot?: boolean;
    }
  | {
      icon: ProfileMenuIcon;
      label: string;
      url: string;
    }
  | {
      icon: ProfileMenuIcon;
      label: string;
      action: () => void;
      disabled?: boolean;
    };

const ICP_NUMBER = "粤ICP备2025444251号-2A";
const ICP_URL = "https://beian.miit.gov.cn/";

export function ProfileScreen() {
  const colors = useColors();
  const s = makeStyles(colors);
  const { t, i18n } = useTranslation();
  const nav = useNavigation<Nav>();
  const [overall, setOverall] = useState<OverallStats | null>(null);
  const [dailyStats, setDailyStats] = useState<DailyStats[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);
  const [unreadFeedback, setUnreadFeedback] = useState(0);
  const [clearingCache, setClearingCache] = useState(false);
  const saveCurrentSession = useReadingSessionStore((s) => s.saveCurrentSession);
  const currentSession = useReadingSessionStore((s) => s.currentSession);
  const stopTTS = useTTSStore((s) => s.stop);

  const loadStats = useCallback(async () => {
    try {
      setStatsLoading(true);
      await saveCurrentSession();

      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 365);

      const [daily, overallStats] = await Promise.all([
        readingStatsService.getDailyStats(startDate, endDate),
        readingStatsService.getOverallStats(),
      ]);
      setDailyStats(daily);
      setOverall(overallStats);
    } catch (err) {
      console.error("[ProfileScreen] Failed to load stats:", err);
    } finally {
      setStatsLoading(false);
    }
  }, [saveCurrentSession]);

  // tab 激活(Pager 模式):激活时刷新统计与未读反馈(替代原 useFocusEffect)
  const tabActive = useContext(TabActiveContext);
  useEffect(() => {
    if (!tabActive) return;
    void loadStats();
    refreshAndCountUnreadFeedback()
      .then(setUnreadFeedback)
      .catch((err) => console.warn("[ProfileScreen] feedback unread refresh:", err));
  }, [tabActive, loadStats]);

  useEffect(() => {
    return eventBus.on("sync:completed", () => {
      void loadStats();
    });
  }, [loadStats]);

  const liveDailyStats = useMemo(
    () => mergeCurrentSessionIntoDailyStats(dailyStats, currentSession),
    [dailyStats, currentSession],
  );
  const liveOverall = useMemo(
    () => mergeCurrentSessionIntoOverallStats(overall, dailyStats, currentSession),
    [overall, dailyStats, currentSession],
  );
  const handleClearCache = useCallback(() => {
    Alert.alert(
      t("profile.clearCacheTitle", "清除缓存"),
      t(
        "profile.clearCacheConfirm",
        "将清除临时导入文件、TTS 音频缓存和其他运行缓存。书籍、笔记、设置和同步数据不会被删除。",
      ),
      [
        { text: t("common.cancel", "取消"), style: "cancel" },
        {
          text: t("profile.clearCacheAction", "清除缓存"),
          style: "destructive",
          onPress: async () => {
            setClearingCache(true);
            try {
              stopTTS();
              stopTTSPreview();
              const result = await clearMobileRuntimeCache();
              Alert.alert(
                t("profile.clearCacheDoneTitle", "缓存已清除"),
                t("profile.clearCacheDoneDesc", {
                  count: result.deletedFiles,
                  size: formatCacheSize(result.deletedBytes),
                }),
              );
            } catch (error) {
              console.error("[ProfileScreen] Failed to clear cache:", error);
              Alert.alert(
                t("profile.clearCacheFailedTitle", "清除失败"),
                error instanceof Error
                  ? error.message
                  : t("profile.clearCacheFailedDesc", "请稍后重试。"),
              );
            } finally {
              setClearingCache(false);
            }
          },
        },
      ],
    );
  }, [stopTTS, t]);

  // Settings menu — matching Tauri ProfilePage exactly
  const menuSections = useMemo<{ title: string; items: ProfileMenuItem[] }[]>(
    () => [
      {
        title: t("settings.general", "通用"),
        items: [
          {
            icon: PaletteIcon,
            label: t("settings.general", "通用"),
            route: "AppearanceSettings" as const,
          },
          {
            icon: TypeIcon,
            label: t("fonts.title", "字体"),
            route: "FontSettings" as const,
          },
          { icon: CloudIcon, label: t("settings.sync", "同步"), route: "SyncSettings" as const },
        ],
      },
      {
        title: t("profile.storage", "存储"),
        items: [
          {
            icon: Trash2Icon,
            label: clearingCache
              ? t("profile.clearingCache", "清除中...")
              : t("profile.clearCache", "清除缓存"),
            action: handleClearCache,
            disabled: clearingCache,
          },
        ],
      },
      {
        title: t("settings.skills", "能力"),
        items: [
          {
            icon: DatabaseIcon,
            label: t("settings.ai_title", "AI 模型"),
            route: "AISettings" as const,
          },
          { icon: Volume2Icon, label: t("tts.title", "语音朗读"), route: "TTSSettings" as const },
          {
            icon: LanguagesIcon,
            label: t("settings.translationTab", "翻译"),
            route: "TranslationSettings" as const,
          },
          { icon: PuzzleIcon, label: t("skills.title", "技能"), route: "Skills" as const },
          {
            icon: CpuIcon,
            label: t("settings.vm_title", "向量模型"),
            route: "VectorModelSettings" as const,
          },
        ],
      },
      {
        title: t("settings.other", "更多"),
        items: [
          {
            icon: MessageSquareIcon,
            label: t("feedback.title", "反馈建议"),
            route: "Feedback" as const,
            showDot: unreadFeedback > 0,
          },
          {
            icon: HelpCircleIcon,
            label: t("about.supportCenter", "帮助中心"),
            url: `https://codedogqby.github.io/ReadAny/${i18n.language === "zh" ? "zh/" : ""}support/`,
          },
          { icon: InfoIcon, label: t("settings.about", "关于"), route: "About" as const },
        ],
      },
    ],
    [t, i18n.language, unreadFeedback, clearingCache, handleClearCache],
  );

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.background }]} edges={["top"]}>
      {/* 手势调试开关(临时):左右 / 上下 / 全开,单点循环 */}
      <TouchableOpacity
        style={s.gestureDebugChip}
        onPress={() => useGestureDebugStore.getState().cycle()}
        activeOpacity={0.7}
      >
        <Text style={s.gestureDebugText}>
          {t("profile.gestureDebugLabel", "手势")}:{" "}
          {GESTURE_DEBUG_LABELS[useGestureDebugStore((s) => s.mode)]}
        </Text>
      </TouchableOpacity>

      <View style={s.header}>
        <View style={s.headerTitleWrap}>
          <Text style={s.headerTitle} numberOfLines={1} maxFontSizeMultiplier={1.6}>
            {t("profile.title", "我的")}
          </Text>
        </View>
        <SyncButton size={20} color={colors.mutedForeground} />
      </View>

      <ScrollView
        style={s.scrollView}
        contentContainerStyle={{ paddingTop: 20, paddingBottom: 12 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Settings menu */}
        {menuSections.map((section) => (
          <View key={section.title} style={s.menuSection}>
            <Text style={s.menuSectionTitle} maxFontSizeMultiplier={1.5}>
              {section.title}
            </Text>
            <View style={s.menuCard}>
              {section.items.map((item, idx) => {
                const Icon = item.icon;
                const itemKey =
                  "route" in item ? item.route : "url" in item ? item.url : item.label;
                const handlePress = () => {
                  if ("disabled" in item && item.disabled) {
                    return;
                  }
                  if ("action" in item && item.action) {
                    item.action();
                  } else if ("url" in item && item.url) {
                    Linking.openURL(item.url);
                  } else if ("route" in item) {
                    nav.navigate(item.route);
                  }
                };
                return (
                  <TouchableOpacity
                    key={itemKey}
                    style={[s.menuItem, idx < section.items.length - 1 && s.menuItemBorder]}
                    onPress={handlePress}
                    disabled={"disabled" in item && item.disabled}
                    activeOpacity={0.7}
                  >
                    <Icon size={20} color={colors.mutedForeground} />
                    <Text style={s.menuItemLabel} maxFontSizeMultiplier={1.7}>
                      {item.label}
                    </Text>
                    {"showDot" in item && item.showDot ? <View style={s.menuItemDot} /> : null}
                    <ChevronRightIcon size={16} color={colors.mutedForeground} />
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ))}

        {/* Version */}
        <Text style={s.version} maxFontSizeMultiplier={1.4}>
          {t("profile.version", { version: Constants.expoConfig?.version ?? "1.0.0" })}
        </Text>
        <TouchableOpacity
          style={s.icpLink}
          onPress={() => Linking.openURL(ICP_URL)}
          activeOpacity={0.7}
        >
          <Text style={s.icpText} maxFontSizeMultiplier={1.4}>
            {ICP_NUMBER}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    gestureDebugChip: {
      alignSelf: "flex-start",
      marginHorizontal: 16,
      marginTop: 8,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    gestureDebugText: {
      fontSize: fontSize.sm,
      color: colors.mutedForeground,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 12,
      borderBottomWidth: 0.5,
      borderBottomColor: colors.border,
    },
    headerTitleWrap: {
      flex: 1,
      minWidth: 0,
      marginRight: 12,
    },
    headerTitle: {
      fontSize: fontSize["2xl"],
      lineHeight: fontSize["2xl"] * 1.4,
      fontWeight: fontWeight.bold,
      color: colors.foreground,
    },
    scrollView: { flex: 1 },
    // Stats
    statsSection: { paddingHorizontal: 16, paddingTop: 16 },
    statsLoading: { alignItems: "center", justifyContent: "center", paddingVertical: 32 },
    statsGrid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -6 },
    statCard: {
      backgroundColor: colors.card,
      borderRadius: radius.xl,
      borderWidth: 0.5,
      borderColor: colors.border,
      paddingHorizontal: 12,
      paddingTop: 12,
      paddingBottom: 10,
      minHeight: 102,
    },
    statCardHeader: {
      marginBottom: 10,
    },
    statCardTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minWidth: 0,
    },
    statCardIconWrap: {
      width: 24,
      height: 24,
      borderRadius: radius.md,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: withOpacity(colors.primary, 0.1),
    },
    statCardTitle: {
      flex: 1,
      fontSize: 11,
      lineHeight: 16,
      fontWeight: fontWeight.medium,
      color: withOpacity(colors.mutedForeground, 0.8),
    },
    statCardBody: { flexDirection: "row", alignItems: "baseline", gap: 4 },
    statCardValue: {
      flexShrink: 1,
      fontSize: 25,
      lineHeight: 32,
      fontWeight: fontWeight.bold,
      color: colors.foreground,
      letterSpacing: -0.8,
    },
    statCardUnit: {
      fontSize: 12,
      lineHeight: 18,
      color: withOpacity(colors.mutedForeground, 0.78),
      fontWeight: fontWeight.medium,
    },
    statCardMetaRow: {
      marginTop: 6,
    },
    statCardMetaText: {
      fontSize: 11,
      lineHeight: 16,
      color: withOpacity(colors.mutedForeground, 0.72),
    },
    statCardMetaLabel: {
      color: withOpacity(colors.mutedForeground, 0.72),
    },
    statCardMetaDivider: {
      color: withOpacity(colors.mutedForeground, 0.46),
    },
    statCardMetaValue: {
      fontWeight: fontWeight.semibold,
      color: withOpacity(colors.foreground, 0.78),
    },
    // Heatmap
    heatmapSection: {
      marginHorizontal: 16,
      marginTop: 16,
      backgroundColor: colors.card,
      borderRadius: radius.xl,
      borderWidth: 0.5,
      borderColor: colors.border,
      padding: 16,
    },
    heatmapHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginBottom: 12,
    },
    heatmapTitle: {
      flex: 1,
      minWidth: 0,
      fontSize: fontSize.sm,
      lineHeight: fontSize.sm * 1.5,
      fontWeight: fontWeight.medium,
      color: colors.mutedForeground,
    },
    heatmapDetailBtn: {
      flexShrink: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    heatmapDetailText: {
      fontSize: fontSize.xs,
      lineHeight: fontSize.xs * 1.5,
      color: colors.primary,
    },
    heatmapContainer: { width: "100%" },
    heatmapGrid: { alignSelf: "center" },
    heatmapLegend: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 4,
      marginTop: 8,
    },
    heatmapLegendText: { fontSize: 9, color: colors.mutedForeground },
    heatmapLegendCell: { width: 8, height: 8, borderRadius: 2 },
    // Menu
    menuSection: { paddingHorizontal: 16, marginTop: 16 },
    menuSectionTitle: {
      fontSize: fontSize.xs,
      lineHeight: fontSize.xs * 1.5,
      fontWeight: fontWeight.medium,
      color: colors.mutedForeground,
      textTransform: "uppercase",
      letterSpacing: 0.8,
      marginBottom: 8,
    },
    menuCard: {
      backgroundColor: colors.card,
      borderRadius: radius.xl,
      borderWidth: 0.5,
      borderColor: colors.border,
      overflow: "hidden",
    },
    menuItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    menuItemBorder: { borderBottomWidth: 0.5, borderBottomColor: colors.border },
    menuItemLabel: {
      flex: 1,
      fontSize: fontSize.md,
      lineHeight: fontSize.md * 1.5,
      color: colors.foreground,
    },
    menuItemDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.destructive,
    },
    version: {
      textAlign: "center",
      fontSize: fontSize.xs,
      lineHeight: fontSize.xs * 1.6,
      color: colors.mutedForeground,
      marginTop: 16,
      marginBottom: 2,
    },
    icpLink: {
      alignSelf: "center",
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    icpText: {
      textAlign: "center",
      fontSize: fontSize.xs,
      lineHeight: fontSize.xs * 1.6,
      color: colors.mutedForeground,
    },
  });
