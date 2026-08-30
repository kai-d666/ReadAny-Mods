/**
 * ReadingStatsPanel — 第二层(双板块,全屏手势驱动)。
 *
 * 一个全板手势管三件事(微信式共同区):
 * - 纵向向上:内容到顶后 → 面板跟手收回(drag 由外层共享值驱动)
 * - 横向:板块①「阅读统计」/ 板块②「详情」跟手横滑 + 松手吸附
 * - 与滚动共存:两个板块的 GHScrollView 同时收 move(simultaneousWithExternalGesture)
 * 二级板块不再用嵌套 PagerView(那是移动被吞、判死活结的根源)。
 */
import { HeatmapSection, StatCardsGrid } from "@/components/profile/stats-blocks";
import StatsScreen from "@/screens/StatsScreen";
import type { DailyStats, OverallStats } from "@readany/core/stats";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, ScrollView as GHScrollView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { CLOSE_T, OPEN_T } from "@/components/profile/PullDownHost";
import {
  type ThemeColors,
  fontSize,
  fontWeight,
  useColors,
  withOpacity,
} from "../../styles/theme";

interface ReadingStatsPanelProps {
  drag: SharedValue<number>;
  scrollY: SharedValue<number>;
  visible: boolean;
  closePanel: () => void;
  overall: OverallStats | null;
  dailyStats: DailyStats[];
  loading: boolean;
}

export function ReadingStatsPanel({
  drag,
  scrollY,
  visible,
  closePanel,
  overall,
  dailyStats,
  loading,
}: ReadingStatsPanelProps) {
  const colors = useColors();
  const s = makeStyles(colors);
  const { t } = useTranslation();
  const { width: W, height: screenH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [tabIdx, setTabIdx] = useState(0);
  const dragStartRef = useRef(0);
  const tabX = useSharedValue(0);
  const panX = useSharedValue(0);
  const panelScrollY = useSharedValue(0);
  // 板块与面板收回共用的全板手势(manual:与 GHScrollView 自动协调,失败即交还滚动)
  const touchStartX = useSharedValue(0);
  const touchStartY = useSharedValue(0);
  const gesture = useRef(
    Gesture.Pan()
      .manualActivation(true)
      .onTouchesDown((e) => {
        const tt = e.changedTouches[0] ?? e.allTouches?.[0];
        if (tt) {
          touchStartX.value = tt.x;
          touchStartY.value = tt.y;
        }
      })
      .onTouchesMove((e, mgr) => {
        const tt = e.changedTouches[0] ?? e.allTouches?.[0];
        const dx = (tt ? tt.x : 0) - touchStartX.value;
        const dy = (tt ? tt.y : 0) - touchStartY.value;
        const horizontal = Math.abs(dx) > Math.abs(dy) * 1.3;
        if (Math.abs(dx) > 14 || Math.abs(dy) > 14) {
          if (horizontal || panelScrollY.value <= 2) mgr.activate();
          else mgr.fail(); // 内容未到顶:交给滚动
        }
      })
      .onStart(() => {
        dragStartRef.current = drag.value;
      })
      .onUpdate((e) => {
        const horizontal = Math.abs(e.translationX) > Math.abs(e.translationY) * 1.3;
        if (horizontal) {
          panX.value = e.translationX;
          return;
        }
        if (panelScrollY.value > 2) return; // 内容未到顶:交给滚动
        drag.value = Math.max(0, Math.min(screenH, dragStartRef.current + e.translationY));
      })
      .onEnd((e) => {
        const horizontal = Math.abs(e.translationX) > Math.abs(e.translationY) * 1.3;
        if (horizontal) {
          const next = Math.abs(e.translationX) > W * 0.22 ? (e.translationX < 0 ? 1 : -1) : 0;
          const target = Math.max(0, Math.min(1, tabIdx + next));
          tabX.value = withTiming(-target * W, OPEN_T);
          panX.value = withTiming(0, OPEN_T);
          if (target !== tabIdx) runOnJS(setTabIdx)(target);
          return;
        }
        const now = drag.value;
        const pullBack = now < screenH * 0.9 || e.velocityY < -400;
        drag.value = withTiming(pullBack ? 0 : screenH, pullBack ? CLOSE_T : OPEN_T);
        if (pullBack) runOnJS(closePanel)();
      }),
  ).current;

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: drag.value - screenH }],
  }));
  const boardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tabX.value + panX.value }],
  }));

  const bodyScrollHandler = useAnimatedScrollHandler((e) => {
    panelScrollY.value = e.contentOffset.y;
    scrollY.value = e.contentOffset.y;
  });

  const switchTab = (i: number) => {
    tabX.value = withTiming(-i * W, OPEN_T);
    setTabIdx(i);
  };

  return (
    <View
      style={[StyleSheet.absoluteFill, { paddingTop: insets.top }]}
      pointerEvents={visible ? "auto" : "box-none"}
    >
      {visible ? (
        <GestureDetector gesture={gesture}>
          <Animated.View style={[s.panel, panelStyle]}>
            <View style={s.panelHeader}>
              <View style={s.handleBar} />
              <View style={s.headerRow}>
                {[
                  { key: "readingPanelTitle", fallback: "阅读统计" },
                  { key: "panelDetailTab", fallback: "详情" },
                ].map((item, i) => {
                  const active = tabIdx === i;
                  return (
                    <TouchableOpacity
                      key={item.key}
                      style={[s.tabBtn, active && s.tabBtnActive]}
                      onPress={() => switchTab(i)}
                      activeOpacity={0.7}
                    >
                      <Text
                        style={[s.tabBtnText, active && s.tabBtnTextActive]}
                        numberOfLines={1}
                        maxFontSizeMultiplier={1.5}
                      >
                        {t(`profile.${item.key}`, item.fallback)}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <View style={s.board}>
              <Animated.View style={[s.boardInner, boardStyle]}>
                <View style={{ width: W }} key="stats">
                  <GHScrollView
                    style={{ height: "100%" }}
                    contentContainerStyle={{ paddingBottom: 48 }}
                    showsVerticalScrollIndicator={false}
                    onScroll={bodyScrollHandler}
                    scrollEventThrottle={16}
                  >
                    <StatCardsGrid
                      overall={overall}
                      loading={loading}
                      onOpenStats={() => switchTab(1)}
                    />
                    <HeatmapSection dailyStats={dailyStats} onOpenStats={() => switchTab(1)} />
                  </GHScrollView>
                </View>
                <View style={{ width: W }} key="detail">
                  <GHScrollView>
                    {tabIdx === 1 ? <StatsScreen embed /> : null}
                  </GHScrollView>
                </View>
              </Animated.View>
            </View>
          </Animated.View>
        </GestureDetector>
      ) : (
        <Animated.View style={[s.panel, panelStyle]} />
      )}
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
      paddingHorizontal: 12,
      height: 34,
      gap: 10,
    },
    tabBtn: {
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 5,
      backgroundColor: colors.muted,
    },
    tabBtnActive: {
      backgroundColor: withOpacity(colors.primary, 0.12),
    },
    tabBtnText: {
      fontSize: fontSize.sm,
      lineHeight: fontSize.sm * 1.4,
      fontWeight: fontWeight.medium,
      color: colors.mutedForeground,
    },
    tabBtnTextActive: {
      color: colors.primary,
      fontWeight: fontWeight.semibold,
    },
    board: { flex: 1, overflow: "hidden" },
    boardInner: { flexDirection: "row", flex: 1 },
  });
