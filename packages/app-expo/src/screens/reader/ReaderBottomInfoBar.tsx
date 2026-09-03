/**
 * ReaderBottomInfoBar — 阅读器底部信息条(沉浸阅读态),仿系统状态栏的页内版。
 * 三段式:左 = (电量百分数) 当前时间 HH:mm;中 = 章节 (页/总页);右 = 全书进度%。
 * 自身完成 absolute 定位(基于 insets),背景为半透明浅灰底条,中段 flex 居中。
 */
import { View, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/styles/theme";
import { makeStyles } from "./reader-styles";

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
  const batteryNumber = batteryLevel == null ? "--" : `${Math.round(batteryLevel * 100)}`;
  const percentText = (progress * 100).toFixed(1);
  const middle =
    currentPage > 0 && totalPages > 0
      ? `${chapterLabel} (${currentPage}/${totalPages})`
      : `${chapterLabel} (${percentText}%)`;

  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: (insets.left ?? 0) + 18,
        right: (insets.right ?? 0) + 18,
        // 三键由阅读器永隐藏(沉浸),insets.bottom 残留旧值会把底栏浮高,固定贴底 6
        bottom: 6,
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 10,
        paddingVertical: 3,
      }}
    >
      <Text style={s.bottomInfoText}>
        ({batteryNumber}) {clock}
      </Text>
      <Text
        style={[
          s.bottomInfoText,
          { flex: 1, textAlign: "center", marginHorizontal: 10 },
        ]}
        numberOfLines={1}
      >
        {middle}
      </Text>
      <Text style={s.bottomInfoText}>{percentText}%</Text>
    </View>
  );
}
