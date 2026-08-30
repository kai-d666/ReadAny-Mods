/**
 * PullDownHost — 微信式双层下拉宿主(书库页/任何长篇页面通用)。
 *
 * ▪ Layer1(children)整体平移;Layer2(layer2)紧贴其下方跟出,同 drag 驱动
 * ▪ 全屏手势:当前层内容到顶后下拉接管(仅纵向;上下保留,横向不进详情,
 *   进 StatsScreen 详情的入口 = 面板内「查看详情」按钮,2026-08-31 用户)
 * ▪ 弹簧临界偏过阻尼:一动到位即停稳,无来回晃动
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { usePanelControl } from "@/stores/panel-control";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

/**
 * 开合一律 timing(减速曲线):单程落位、零过冲 —— 不会来回晃动。
 * 一次停稳后立即静止(与用户要求:不晃、到位即停)。
 */
const OPEN_T = { duration: 220, easing: Easing.out(Easing.cubic) };
const CLOSE_T = { duration: 180, easing: Easing.out(Easing.cubic) };
/** 开→关阈值:从全开位下拉超过屏高 10% 即收回(用户指定 10) */
const CLOSE_THRESHOLD = 0.1;

interface PullDownHostProps {
  /** Layer1 内容(render prop:第 1 页内容的 scrollY 交给它绑定到内容 onScroll) */
  children: (ctx: { scrollY: SharedValue<number>; openPanel: () => void }) => React.ReactNode;
  /** Layer2(如 ReadingStatsPanel):drag 驱动位移,scrollY 为其内容滚动位置,visible 控命中 */
  layer2: (ctx: {
    drag: SharedValue<number>;
    scrollY: SharedValue<number>;
    visible: boolean;
  }) => React.ReactNode;
}

export function PullDownHost({ children, layer2 }: PullDownHostProps) {
  const { height: screenH } = useWindowDimensions();
  const [panelOpen, setPanelOpen] = useState(false);
  const drag = useSharedValue(0);
  const scrollY1 = useSharedValue(0);
  const scrollY2 = useSharedValue(0);
  const panelOpenSV = useSharedValue(false);
  const dragStartRef = useRef(0);
  const touchStartX = useSharedValue(0);
  const touchStartY = useSharedValue(0);

  const openPanel = useCallback(() => {
    setPanelOpen(true);
    panelOpenSV.value = true;
    drag.value = withTiming(screenH, { duration: OPEN_T.duration, easing: OPEN_T.easing });
  }, [drag, screenH, panelOpenSV]);

  // 底栏切换等外部收回:与跳转动画同步收(跳转先行,面板在滑走的旧页里收),
  // 避免"先收面板→露出第一页→再跳"的中间层。手势下拉收回仍走 onEnd 的 withTiming。
  const closePanel = useCallback(() => {
    panelOpenSV.value = false;
    drag.value = withTiming(0, CLOSE_T);
    setPanelOpen(false);
  }, [drag, panelOpenSV]);

  // 附庸控制:底栏点任意标签等外围操作 → 立即收回面板(未开时 close 为 null 无害)
  useEffect(() => {
    usePanelControl.getState().register(() => closePanel());
    return () => usePanelControl.getState().register(null);
  }, [closePanel]);

  const layer1Style = useAnimatedStyle(() => ({ transform: [{ translateY: drag.value }] }));

  const gesture = useRef(
    Gesture.Pan()
      .manualActivation(true)
      .onTouchesDown((e, mgr) => {
        const t = e.changedTouches[0] ?? e.allTouches?.[0];
        if (t) {
          touchStartX.value = t.x;
          touchStartY.value = t.y;
        }
        if (panelOpenSV.value ? scrollY2.value > 2 : scrollY1.value > 2) {
          mgr.fail(); // 当前页内容未到顶:交给页面自身滚动
        }
      })
      .onTouchesMove((e, mgr) => {
        const t = e.changedTouches[0] ?? e.allTouches?.[0];
        const dx = (t ? t.x : 0) - touchStartX.value;
        const dy = (t ? t.y : 0) - touchStartY.value;
        const horizontal = Math.abs(dx) > Math.abs(dy) * 1.4;
        if (panelOpenSV.value) {
          if (horizontal) {
            if (Math.abs(dx) > 12) mgr.activate();
            else mgr.fail();
          } else if (Math.abs(dy) >= 3) {
            if (scrollY2.value <= 2) mgr.activate();
            else mgr.fail();
          }
        } else if (Math.abs(dy) >= 3) {
          if (scrollY1.value <= 2 && dy > 0) mgr.activate();
          else mgr.fail();
        }
      })
      .onStart(() => {
        dragStartRef.current = drag.value;
      })
      .onUpdate((e) => {
        const dx = e.translationX;
        const dy = e.translationY;
        if (Math.abs(dx) > Math.abs(dy) * 1.4) return; // 横向交给 onEnd
        const next = dragStartRef.current + dy;
        const clamped = Math.max(0, Math.min(screenH, next));
        drag.value = clamped + (next - clamped) * 0.3; // 过冲阻尼
      })
      .onEnd((e) => {
        const horizontal = Math.abs(e.translationX) > Math.abs(e.translationY) * 1.4;
        if (horizontal) return; // 横向不作任何事(详情仅经「查看详情」按钮)
        const now = drag.value;
        // 关→开:拖过 30% 或快甩;开→关:从全开位下拉超过屏高 27% 即收回(零晃动 timing)
        const open = panelOpenSV.value
          ? now > screenH * (1 - CLOSE_THRESHOLD) || e.velocityY > 600
          : now > screenH * 0.3 || (e.velocityY > 600 && now > screenH * 0.1);
        drag.value = withTiming(open ? screenH : 0, open ? OPEN_T : CLOSE_T);
        panelOpenSV.value = open;
        runOnJS(setPanelOpen)(open);
      }),
  ).current;

  return (
    <GestureDetector gesture={gesture}>
      <View style={{ flex: 1 }}>
        <Animated.View style={[s.layer, layer1Style]}>
          {children({ scrollY: scrollY1, openPanel })}
        </Animated.View>
        <View style={StyleSheet.absoluteFill} pointerEvents={panelOpen ? "auto" : "box-none"}>
          {layer2({ drag, scrollY: scrollY2, visible: panelOpen })}
        </View>
      </View>
    </GestureDetector>
  );
}

const s = StyleSheet.create({
  layer: { flex: 1 },
});
