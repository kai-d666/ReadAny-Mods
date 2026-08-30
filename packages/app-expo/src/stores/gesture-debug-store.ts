/**
 * gesture-debug — 手势档位临时开关(「我的」页顶部,单击循环):
 * "horizontal" 左右(四 tab/板块) | "vertical" 上下(下拉面板) | "all" 全开
 *
 * detailMode — 详情板块(StatsScreen embed)卡顿定位实验(第二批开关):
 * "full"(现状:切到才挂载) | "placeholder"(屏蔽内容,只渲染占位) | "preload"(面板一开就挂载)
 */
import { create } from "zustand";

export type GestureDebugMode = "horizontal" | "vertical" | "all";
export type DetailDebugMode = "full" | "placeholder" | "preload";

export const GESTURE_DEBUG_LABELS: Record<GestureDebugMode, string> = {
  horizontal: "左右",
  vertical: "上下",
  all: "全开",
};

export const DETAIL_DEBUG_LABELS: Record<DetailDebugMode, string> = {
  full: "全量",
  placeholder: "占位",
  preload: "预载",
};

const NEXT: Record<GestureDebugMode, GestureDebugMode> = {
  horizontal: "vertical",
  vertical: "all",
  all: "horizontal",
};

const NEXT_DETAIL: Record<DetailDebugMode, DetailDebugMode> = {
  full: "placeholder",
  placeholder: "preload",
  preload: "full",
};

export const useGestureDebugStore = create<{
  mode: GestureDebugMode;
  detailMode: DetailDebugMode;
  cycle: () => void;
  cycleDetail: () => void;
}>((set) => ({
  mode: "all",
  detailMode: "full",
  cycle: () => set((s) => ({ mode: NEXT[s.mode] })),
  cycleDetail: () => set((s) => ({ detailMode: NEXT_DETAIL[s.detailMode] })),
}));
