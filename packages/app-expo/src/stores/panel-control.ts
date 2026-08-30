/**
 * panel-control — 下拉面板的"附庸控制":供 Tab 切换等外围触发真实收回。
 * (PullDownHost 挂载时注册 close,外部 requestClose 即实际关面板)
 */
import { create } from "zustand";

export const usePanelControl = create<{
  close: (() => void) | null;
  requestClose: () => void;
  register: (fn: (() => void) | null) => void;
}>((set, get) => ({
  close: null,
  requestClose: () => {
    get().close?.();
  },
  register: (fn) => set({ close: fn }),
}));
