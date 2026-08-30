/**
 * stats-blocks — 阅读统计共享块(供「我的」页与下拉统计面板复用):
 * StatCardsGrid(总时长/当日阅读时长/已读/连续四卡)+ HeatmapSection(阅读活动热力图+查看详情)。
 * 2026-08-31 用户:字数/速度/场次统计整体移除;字数卡位换「当日阅读时长」。
 */
import { BarChart3Icon, BookOpenIcon, ClockIcon, FlameIcon } from "@/components/ui/Icon";
import { useResponsiveLayout } from "@/hooks/use-responsive-layout";
import {
  mergeCurrentSessionIntoDailyStats,
  mergeCurrentSessionIntoOverallStats,
} from "@/lib/stats/live-reading-stats";
import { formatTimeLocalized } from "@/screens/stats/stats-utils";
import type { DailyStats, OverallStats } from "@readany/core/stats";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useReadingSessionStore } from "@/stores";
import { readingStatsService } from "@readany/core/stats";
import {
  ActivityIndicator,
  type StyleProp,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ViewStyle,
} from "react-native";
import {
  type ThemeColors,
  fontSize,
  fontWeight,
  radius,
  useColors,
  withOpacity,
} from "../../styles/theme";

/* ── StatCard ──────────────────────────────────────────────────────────────── */

export interface StatCardProps {
  icon: React.ReactNode;
  title: string;
  value: string;
  unit?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

export function StatCard({ icon, title, value, unit, onPress, style }: StatCardProps) {
  const colors = useColors();
  const s = makeStyles(colors);
  return (
    <TouchableOpacity activeOpacity={0.7} onPress={onPress} style={[s.statCard, style]}>
      <View style={s.statCardTitleRow}>
        <View style={s.statCardIconWrap}>{icon}</View>
        <Text style={s.statCardTitle} numberOfLines={1} maxFontSizeMultiplier={1.6}>
          {title}
        </Text>
      </View>
      <View style={s.statCardBody}>
        <Text style={s.statCardValue} numberOfLines={1} maxFontSizeMultiplier={1.8}>
          {value}
        </Text>
        {unit && (
          <Text style={s.statCardUnit} maxFontSizeMultiplier={1.6}>
            {unit}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

/* ── 概览四卡 ──────────────────────────────────────────────────────────────── */

interface StatCardsGridProps {
  overall: OverallStats | null;
  dailyStats: DailyStats[];
  loading: boolean;
  onOpenStats: () => void;
}

/** 统计卡 grid(总时长/当日阅读时长/已读/连续阅读),点卡或点击查看均进统计详情 */
export function StatCardsGrid({ overall, dailyStats, loading, onOpenStats }: StatCardsGridProps) {
  const { t, i18n } = useTranslation();
  const colors = useColors();
  const s = makeStyles(colors);
  const layout = useResponsiveLayout();
  const isZh = i18n.language.startsWith("zh");
  const statsGridColumns = layout.isTablet ? 4 : 2;
  const statCardSlotWidth = `${100 / statsGridColumns}%` as `${number}%`;

  const booksRead = overall?.totalBooks ?? 0;
  const totalTime = overall
    ? formatTimeLocalized(overall.totalReadingTime, isZh)
    : formatTimeLocalized(0, isZh);
  // 当日阅读时长(dailyStats 已并入当前会话,找今天这一条)
  const todayKey = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const todayMinutes = dailyStats.find((d) => d.date === todayKey)?.totalTime ?? 0;
  const todayTime = formatTimeLocalized(todayMinutes, isZh);
  const streak = overall?.currentStreak ?? 0;

  const cards = [
    {
      key: "time",
      icon: <ClockIcon size={16} color={colors.primary} />,
      title: t("profile.totalTime", "总时长"),
      value: totalTime,
    },
    {
      key: "todayTime",
      icon: <ClockIcon size={16} color={colors.primary} />,
      title: t("profile.todayReadingTime", "当日阅读时长"),
      value: todayTime,
    },
    {
      key: "books",
      icon: <BookOpenIcon size={16} color={colors.primary} />,
      title: t("profile.booksRead", "已读"),
      value: String(booksRead),
      unit: t("profile.booksUnit", "本"),
    },
    {
      key: "streak",
      icon: <FlameIcon size={16} color={colors.primary} />,
      title: t("profile.streak", "连续阅读"),
      value: String(streak),
      unit: t("profile.daysUnit", "天"),
    },
  ];

  return (
    <View style={s.statsSection}>
      {loading ? (
        <View style={s.statsLoading}>
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        </View>
      ) : (
        <View style={s.statsGrid}>
          {cards.map((card) => (
            <View
              key={card.key}
              style={{
                width: statCardSlotWidth,
                paddingHorizontal: 6,
                paddingBottom: 12,
              }}
            >
              <StatCard
                icon={card.icon}
                title={card.title}
                value={card.value}
                unit={card.unit}
                onPress={onOpenStats}
                style={{ width: "100%" }}
              />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/* ── 阅读活动热力图 ────────────────────────────────────────────────────────── */

function MiniHeatmap({ dailyStats }: { dailyStats: DailyStats[] }) {
  const themeColors = useColors();
  const s = makeStyles(themeColors);
  const { t } = useTranslation();
  const WEEKS = 16;
  const DAYS_PER_WEEK = 7;
  const GAP = 2;
  const [containerWidth, setContainerWidth] = useState(0);
  const [selectedCell, setSelectedCell] = useState<{
    date: string;
    time: number;
    x: number;
    y: number;
  } | null>(null);

  // Calculate cell size based on container width
  // containerWidth = WEEKS * CELL + (WEEKS - 1) * GAP
  const CELL = containerWidth > 0 ? Math.floor((containerWidth - (WEEKS - 1) * GAP) / WEEKS) : 8;
  const gridWidth = WEEKS * CELL + (WEEKS - 1) * GAP;
  const gridHeight = DAYS_PER_WEEK * CELL + (DAYS_PER_WEEK - 1) * GAP;

  const cells = useMemo(() => {
    const statsMap = new Map<string, number>();
    for (const d of dailyStats) statsMap.set(d.date, d.totalTime);

    const today = new Date();
    const result: { col: number; row: number; intensity: number; date: string; time: number }[] =
      [];
    const maxTime = Math.max(1, ...dailyStats.map((d) => d.totalTime));

    for (let w = WEEKS - 1; w >= 0; w--) {
      for (let d = 0; d < DAYS_PER_WEEK; d++) {
        const date = new Date(today);
        date.setDate(today.getDate() - (w * 7 + (6 - d)));
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        const time = statsMap.get(key) || 0;
        result.push({
          col: WEEKS - 1 - w,
          row: d,
          intensity: time > 0 ? Math.min(1, time / maxTime) : 0,
          date: key,
          time,
        });
      }
    }
    return result;
  }, [dailyStats]);

  const getColor = (intensity: number) => {
    if (intensity <= 0) return themeColors.muted;
    if (intensity < 0.25) return withOpacity(themeColors.primary, 0.3);
    if (intensity < 0.5) return withOpacity(themeColors.primary, 0.5);
    if (intensity < 0.75) return withOpacity(themeColors.primary, 0.7);
    return withOpacity(themeColors.primary, 0.9);
  };

  const formatDisplayDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const formatTime = (minutes: number) => {
    if (minutes < 60) return `${Math.round(minutes)}${t("common.minutes", "分钟")}`;
    return `${(minutes / 60).toFixed(1)}${t("common.hours", "小时")}`;
  };

  const handleCellPress = (cell: { date: string; time: number }, col: number, row: number) => {
    const x = col * (CELL + GAP) + CELL / 2;
    const y = row * (CELL + GAP) + CELL / 2;
    if (selectedCell?.date === cell.date) {
      setSelectedCell(null);
    } else {
      setSelectedCell({ ...cell, x, y });
      setTimeout(() => setSelectedCell(null), 1000);
    }
  };

  // Calculate tooltip position with boundary detection
  const getTooltipStyle = () => {
    if (!selectedCell || containerWidth === 0) return null;
    const TOOLTIP_WIDTH = 80;
    const TOOLTIP_HEIGHT = 24;

    let left = selectedCell.x - TOOLTIP_WIDTH / 2;
    let top = selectedCell.y - TOOLTIP_HEIGHT - 8;

    // Boundary detection
    if (left < 4) left = 4;
    if (left + TOOLTIP_WIDTH > containerWidth - 4) left = containerWidth - TOOLTIP_WIDTH - 4;
    if (top < 4) top = selectedCell.y + CELL + 4; // Show below if no space above

    return { left, top };
  };

  const tooltipStyle = getTooltipStyle();

  return (
    <View
      style={s.heatmapContainer}
      onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
    >
      {containerWidth > 0 && (
        <View style={[s.heatmapGrid, { width: gridWidth, height: gridHeight }]}>
          {cells.map((cell) => (
            <TouchableOpacity
              key={cell.date}
              style={{
                position: "absolute",
                left: cell.col * (CELL + GAP),
                top: cell.row * (CELL + GAP),
                width: CELL,
                height: CELL,
                borderRadius: Math.max(2, CELL * 0.25),
                backgroundColor: getColor(cell.intensity),
              }}
              onPress={() => handleCellPress(cell, cell.col, cell.row)}
              activeOpacity={0.7}
            />
          ))}
        </View>
      )}

      {/* Selected cell tooltip */}
      {selectedCell && tooltipStyle && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            ...tooltipStyle,
            backgroundColor: themeColors.card,
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 4,
            borderWidth: 0.5,
            borderColor: themeColors.border,
            minWidth: 80,
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.15,
            shadowRadius: 2,
            elevation: 3,
          }}
        >
          <Text
            style={{
              fontSize: 12,
              color: themeColors.cardForeground,
              fontWeight: "500",
              textAlign: "center",
            }}
          >
            {formatDisplayDate(selectedCell.date)} ·{" "}
            {selectedCell.time > 0 ? formatTime(selectedCell.time) : t("stats.noReading", "无阅读")}
          </Text>
        </View>
      )}
    </View>
  );
}

interface HeatmapSectionProps {
  dailyStats: DailyStats[];
  onOpenStats: () => void;
}

/* ── 数据加载(书库/我的页共用)──────────────────────────────────── */

/** 加载近一年日统计 + 总览(并入当前未保存会话后可显示) */
export function useReadingStatsData(): {
  overall: OverallStats | null;
  dailyStats: DailyStats[];
  loading: boolean;
  reload: () => Promise<void>;
} {
  const saveCurrentSession = useReadingSessionStore((s) => s.saveCurrentSession);
  const [overall, setOverall] = useState<OverallStats | null>(null);
  const [dailyStats, setDailyStats] = useState<DailyStats[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setLoading(true);
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
      setLoading(false);
    }
  }, [saveCurrentSession]);

  // 挂载即自动加载(此前只暴露 reload 无人调用 → 永远 loading)
  useEffect(() => {
    void reload();
  }, [reload]);

  return { overall, dailyStats, loading, reload };
}

/** 阅读活动卡:标题 + 查看详情(保留原按钮)+ 热力图 */
export function HeatmapSection({ dailyStats, onOpenStats }: HeatmapSectionProps) {
  const colors = useColors();
  const s = makeStyles(colors);
  const { t } = useTranslation();
  return (
    <View style={s.heatmapSection}>
      <View style={s.heatmapHeader}>
        <Text style={s.heatmapTitle} numberOfLines={1} maxFontSizeMultiplier={1.5}>
          {t("profile.readingActivity", "阅读活动")}
        </Text>
        <TouchableOpacity style={s.heatmapDetailBtn} onPress={onOpenStats}>
          <BarChart3Icon size={14} color={colors.primary} />
          <Text style={s.heatmapDetailText} numberOfLines={1} maxFontSizeMultiplier={1.4}>
            {t("profile.viewDetails", "查看详情")}
          </Text>
        </TouchableOpacity>
      </View>
      <MiniHeatmap dailyStats={dailyStats} />
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
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
    heatmapTooltip: {
      position: "absolute",
      backgroundColor: colors.background,
      borderRadius: 4,
      borderWidth: 0.5,
      borderColor: colors.border,
      paddingHorizontal: 5,
      paddingVertical: 3,
    },
    heatmapTooltipText: { fontSize: 9, color: colors.foreground },
    heatmapLegend: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 4,
      marginTop: 8,
    },
    heatmapLegendText: { fontSize: 9, color: colors.mutedForeground },
    heatmapLegendCell: { width: 8, height: 8, borderRadius: 2 },
  });
