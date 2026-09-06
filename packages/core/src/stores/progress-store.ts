/**
 * 进度直读 store(2026-09-06 重构 B):唯一读模型。
 * 进度只记 reading_progress(唯一账本);书库角标/详情/排序/统计/AI 一律经此读取。
 * Book.progress/currentCfi 字段(桌面端共用)标 @deprecated,移动端不再读写。
 */
import { create } from "zustand";
import {
  getProgressProjectionMap,
  getReadingProgressForBook,
} from "../db/progress-queries";

export interface ProgressEntry {
  cfi: string;
  percent: number;
}

interface ProgressStoreState {
  entries: Record<string, ProgressEntry>;
  /** 全量 hydrate(启动/书库加载前;毫秒级全表读) */
  hydrate: () => Promise<void>;
  /** 单本刷新(同步完成后/单本写后) */
  refreshOne: (fileHash: string | null | undefined) => Promise<void>;
  /** 写链路回填(内存即时,不落库——落库由 reading_progress 负责) */
  upsert: (fileHash: string | null | undefined, entry: ProgressEntry) => void;
  get: (fileHash: string | null | undefined) => ProgressEntry | undefined;
}

/** 纯读取角标百分比(展示层;组件渲染时快照,进度 upsert 后下次渲染即最新) */
export function getProgressPercent(fileHash: string | null | undefined): number {
  return useProgressStore.getState().entries[fileHash ?? ""]?.percent ?? 0;
}

/** 纯读取恢复 cfi(展示/调用层) */
export function getProgressCfi(fileHash: string | null | undefined): string | null {
  const entry = useProgressStore.getState().entries[fileHash ?? ""];
  return entry?.cfi || null;
}

export const useProgressStore = create<ProgressStoreState>((set, get) => ({
  entries: {},

  hydrate: async () => {
    try {
      const map = await getProgressProjectionMap();
      set({ entries: Object.fromEntries(map) });
    } catch (err) {
      console.warn("[ProgressStore] hydrate failed:", err);
    }
  },

  refreshOne: async (fileHash) => {
    if (!fileHash) return;
    try {
      const row = await getReadingProgressForBook(fileHash);
      if (row) {
        set((s) => ({
          entries: {
            ...s.entries,
            [fileHash]: { cfi: row.cfi, percent: row.percent },
          },
        }));
      }
    } catch (err) {
      console.warn("[ProgressStore] refreshOne failed:", err);
    }
  },

  upsert: (fileHash, entry) => {
    if (!fileHash) return;
    set((s) => ({ entries: { ...s.entries, [fileHash]: entry } }));
  },

  get: (fileHash) => (fileHash ? get().entries[fileHash] : undefined),
}));
