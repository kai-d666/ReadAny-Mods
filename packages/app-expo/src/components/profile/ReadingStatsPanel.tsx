/**
 * ReadingStatsPanel — 双层滑动模型里的第二层(阅读统计面板)。
 *
 * 微信式:第一页(我的页,含标题)整体上移,本面板**紧贴其后续入**——
 * 位移统一由 ProfileScreen 的全屏 drag 共享值驱动(translateY = drag - screenH)。
 * 本地只负责展示(统计卡 + 热力图 + 顶栏提示);右滑进详情、全屏下拉收回由外层手势处理。
 * 状态栏(时间/电量)区域保留:面板从 insets.top 下方开始。
 */
import { HeatmapSection, StatCardsGrid } from "@/components/profile/stats-blocks";
import type { DailyStats, OverallStats } from "@readany/core/stats";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import {
  type ThemeColors,
  fontSize,
  fontWeight,
  useColors,
  withOpacity,
} from "../../styles/theme";

interface ReadingStatsPanelProps {
  /** 外层 drag(0=关,screenH=全开,由本组件自取屏高),本层 translateY = drag - screenH */
  drag: SharedValue<number>;
  /** 本层内容滚动位置(供外层手势判定"内容到顶">下拉收回) */
  scrollY: SharedValue<number>;
  visible: boolean;
  /** 进入阅读统计页(与「查看详情」同一目标;右滑由外层手势触发) */
  onOpenStats: () => void;
  overall: OverallStats | null;
  dailyStats: DailyStats[];
  loading: boolean;
}

export function ReadingStatsPanel({
  drag,
  scrollY,
  visible,
  onOpenStats,
  overall,
  dailyStats,
  loading,
}: ReadingStatsPanelProps) {
  const colors = useColors();
  const s = makeStyles(colors);
  const { t } = useTranslation();
  const { height: screenH } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: drag.value - screenH }],
  }));

  return (
    <View
      style={[StyleSheet.absoluteFill, { paddingTop: insets.top }]}
      pointerEvents={visible ? "auto" : "box-none"}
    >
      <Animated.View style={[s.panel, panelStyle]}>
        {/* 顶栏:标题 + 右滑提示(手势由外层全屏 Pan 处理) */}
        <View style={s.panelHeader}>
          <View style={s.handleBar} />
          <View style={s.headerRow}>
            <Text style={s.panelTitle} numberOfLines={1} maxFontSizeMultiplier={1.5}>
              {t("profile.readingPanelTitle", "阅读统计")}
            </Text>
            <View style={s.swipeHint}>
              <Text style={s.swipeHintText} numberOfLines={1} maxFontSizeMultiplier={1.4}>
                {t("profile.swipeStatsHint", "右滑查看统计详情")}
              </Text>
            </View>
          </View>
        </View>

        <ScrollView
          style={s.body}
          contentContainerStyle={{ paddingBottom: 48 }}
          showsVerticalScrollIndicator={false}
          onScroll={(e) => {
            scrollY.value = e.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
        >
          <StatCardsGrid overall={overall} loading={loading} onOpenStats={onOpenStats} />
          <HeatmapSection dailyStats={dailyStats} onOpenStats={onOpenStats} />
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    panel: {
      backgroundColor: colors.background,
      height: "100%",
      borderBottomLeftRadius: 20,
      borderBottomRightRadius: 20,
      overflow: "hidden",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.2,
      shadowRadius: 16,
      elevation: 16,
    },
    panelHeader: {
      paddingTop: 6,
      paddingBottom: 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      backgroundColor: withOpacity(colors.background, 0.98),
    },
    handleBar: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
      marginBottom: 4,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      height: 32,
    },
    panelTitle: {
      flex: 1,
      minWidth: 0,
      fontSize: fontSize.base,
      lineHeight: fontSize.base * 1.4,
      fontWeight: fontWeight.semibold,
      color: colors.foreground,
      marginRight: 8,
    },
    swipeHint: {
      flexShrink: 0,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 4,
      backgroundColor: withOpacity(colors.primary, 0.1),
    },
    swipeHintText: {
      fontSize: 11,
      lineHeight: 16,
      color: colors.primary,
    },
    body: {
      flex: 1,
    },
  });
