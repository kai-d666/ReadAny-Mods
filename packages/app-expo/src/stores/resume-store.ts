/**
 * resume-store — "启动恢复"标记:记录最后一次退出 App 时是否停留在阅读器内。
 *
 * 进入阅读器 → 持久化 activeReaderBookId;离开阅读器(pop)→ 清空。
 * App 被杀时清理不执行,文件里保留 bookId → 下次冷启动恢复直达该书的阅读页,
 * 页面位置(进度)由 ReaderScreen 从 DB 恢复,无需额外存 cfi。
 */
import { create } from "zustand";
import { withPersist } from "./persist";

interface ResumeState {
  /** 最后一次退出时阅读器是否打开;打开则记 bookId,否则 null */
  activeReaderBookId: string | null;
  _hasHydrated: boolean;
  setActiveReader: (bookId: string | null) => void;
}

export const useResumeStore = create<ResumeState>()(
  withPersist("resume", (set) => ({
    activeReaderBookId: null,
    _hasHydrated: false,
    setActiveReader: (bookId) => set({ activeReaderBookId: bookId }),
  })),
);
