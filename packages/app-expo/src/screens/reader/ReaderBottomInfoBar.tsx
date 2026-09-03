/**
 * ReaderBottomInfoBar — 阅读器底部信息条,照静读天下样式(原图取样):
 * 全宽直边条(无左右留白/无圆角/贴底),背景 #C2BDA9(比页面暗一档,卡其灰);
 * 文字 10sp 深棕黑 #231E0A;左段 (电量) 为深褐胶囊 #423D29 浅字 + 时间。
 * 三段:左 = (电量) 当前时间 HH:mm;中 = 章节 (页/总页);右 = 全书进度%。
 */
import { View, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSettingsStore } from "@/stores";
import { useColors } from "@/styles/theme";
import { makeStyles } from "./reader-styles";

/** 底栏恒定背景色(原图取样 194,189,169);顶栏复用 */
export const BOTTOM_BAR_BG = "#C2BDA9";
/** 底栏普通文字色(灰,用户 2026-09-04:两栏字体灰色);顶栏复用 */
export const BOTTOM_BAR_FG = "#6A655B";
/** (电量) 胶囊底色(原图取样 66,61,41) */
const BOTTOM_BAR_CAPSULE_BG = "#423D29";
/** 胶囊内浅字 */
const BOTTOM_BAR_CAPSULE_FG = "#E1DCC8";
/** 底栏总高(含 padding),ReaderScreen 预留位与此一致 */
export const READER_BOTTOM_BAR_HEIGHT = 16;

interface ReaderBottomInfoBarProps {
  /** 0..1 电量 */
  batteryLevel: number | null;
  /** 当前时间 HH:mm(由 parent 的 useReaderSystemInfo 每 30s 刷新) */
  clock: string;
  chapterLabel: string;
  currentPage: number;
  totalPages: number;
  /** 0..1 全书进度 */
  progress: number;
}

export function ReaderBottomInfoBar({
  batteryLevel,
  clock,
  chapterLabel,
  currentPage,
  totalPages,
  progress,
}: ReaderBottomInfoBarProps) {
  const colors = useColors();
  const s = makeStyles(colors);
  const insets = useSafeAreaInsets();
  // 底栏背景条显示(开发者模式开关,默认开)
  const showBarBg = useSettingsStore((s) => s.devFlags?.readerBottomBarBackground ?? true);
  const batteryNumber = batteryLevel == null ? "--" : `${Math.round(batteryLevel * 100)}`;
  const percentText = (progress * 100).toFixed(1);
  const middle =
    currentPage > 0 && totalPages > 0
      ? `${chapterLabel} (${currentPage}/${totalPages})`
      : `${chapterLabel} (${percentText}%)`;
  const textStyle = { fontSize: 10, color: BOTTOM_BAR_FG, fontVariant: ["tabular-nums" as const] };

  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: READER_BOTTOM_BAR_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 25,
        backgroundColor: showBarBg ? BOTTOM_BAR_BG : "transparent",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        {/* (电量) 电池描边图标:左侧正极小凸起 + 描边框 + 数字 */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 0 }}>
          <View
            style={{
              width: 1.5,
              height: 5,
              backgroundColor: BOTTOM_BAR_FG,
              borderTopRightRadius: 1,
              borderBottomRightRadius: 1,
              marginRight: -0.5,
            }}
          />
          <View
            style={{
              borderWidth: 1,
              borderColor: BOTTOM_BAR_FG,
              borderRadius: 2,
              paddingHorizontal: 2,
              paddingVertical: 0,
            }}
          >
            <Text style={{ fontSize: 9, lineHeight: 10, color: BOTTOM_BAR_FG }}>
              {batteryNumber}
            </Text>
          </View>
        </View>
        <Text style={textStyle}>{clock}</Text>
      </View>
      <Text style={[textStyle, { flex: 1, textAlign: "center", marginHorizontal: 8 }]} numberOfLines={1}>
        {middle}
      </Text>
      <Text style={textStyle}>{percentText}%</Text>
    </View>
  );
}
