/**
 * panel-control — 下拉面板的"附庸控制":面板是书库页的附庸,触底栏标签等外围操作时
 * 必须立刻撤回第一页(PullDownHost 挂载时注册 close;未开面板时 close 为 null,无害)。
 * 2026-08-31 用户:面板弹出时点任意底部标签(含当前标签)都要立即收面板、恢复正常交互。
 */
import { create } from "zustand";

export const usePanelControl = create<{
  close: (() => void) | null;
  register: (fn: (() => void) | null) => void;
  requestClose: () => void;
}>((set, get) => ({
  close: null,
  register: (fn) => set({ close: fn }),
  requestClose: () => {
    get().close?.();
  },
}));
