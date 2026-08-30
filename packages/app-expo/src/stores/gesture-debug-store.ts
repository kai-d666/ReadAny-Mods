/**
 * gesture-debug — 手势档位临时开关(「我的」页顶部,单击循环):
 * "horizontal" 左右(四 tab/板块) | "vertical" 上下(下拉面板) | "all" 全开
 */
import { create } from "zustand";

export type GestureDebugMode = "horizontal" | "vertical" | "all";

export const GESTURE_DEBUG_LABELS: Record<GestureDebugMode, string> = {
  horizontal: "左右",
  vertical: "上下",
  all: "全开",
};

const NEXT: Record<GestureDebugMode, GestureDebugMode> = {
  horizontal: "vertical",
  vertical: "all",
  all: "horizontal",
};

export const useGestureDebugStore = create<{
  mode: GestureDebugMode;
  cycle: () => void;
}>((set) => ({
  mode: "all",
  cycle: () => set((s) => ({ mode: NEXT[s.mode] })),
}));
