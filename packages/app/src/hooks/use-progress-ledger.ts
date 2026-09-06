/**
 * 桌面端进度账本钩子: 进度相关的防抖、记账、上传逻辑收编于此。
 *
 * 架构设计 (单写入口 & 伪写抑制):
 * - 唯一写入口 = 节流 5s 落盘 (reading_progress 表 + useProgressStore 内存账本);
 *   开书 1.5s 稳定窗口与 <0.1% 抖动过滤保证仅记录真实翻页。
 * - 兜底退书与后台触发 flushPending / syncOnBackground。
 * - 针对大小写敏感漏洞进行 normalizedHash (toLowerCase) 规整。
 * - 针对旧版本书籍进度提供 books.currentCfi 回退恢复兼容。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { throttle } from "@readany/core/utils";
import {
  getReadingProgressForBook,
  saveReadingProgressForBook,
} from "@readany/core/db/progress-queries";
import { useProgressStore } from "@readany/core/stores/progress-store";
import { useSyncStore } from "@/stores/sync-store";
import { useLibraryStore } from "@/stores/library-store";

/** 渲染器抖动阈值: 稳定后 ±0.1% 级波动不触发翻页写入 */
const PROGRESS_WRITE_MIN_DELTA = 0.001;
/** 每 5 页自动触发一次后台静默同步快照 */
const PAGE_AUTO_UPLOAD_DELTA = 5;

export function useProgressLedger(
  bookId: string,
  fileHash: string | null | undefined,
) {
  const upsert = useProgressStore((s) => s.upsert);

  // 伪写抑制与稳定窗口状态
  const loadedCfiBaseRef = useRef<string | null>(null);
  const progressSettledRef = useRef(false);
  const progressSettleDeadlineRef = useRef(0);
  const progressWrittenRef = useRef(false);
  const settledFractionRef = useRef(0);
  const lastAutoUploadPageRef = useRef(0);

  // 待落盘的最新真实翻页 (防止节流定时器未到期退书导致丢失或旧进度上传)
  const pendingWriteRef = useRef<{ cfi: string; percent: number; page: number } | null>(null);

  // 换书重置状态
  useEffect(() => {
    loadedCfiBaseRef.current = null;
    progressSettledRef.current = false;
    progressSettleDeadlineRef.current = 0;
    progressWrittenRef.current = false;
    settledFractionRef.current = 0;
    lastAutoUploadPageRef.current = 0;
    pendingWriteRef.current = null;
  }, [bookId]);

  const writeLedger = useCallback(
    (cfi: string, percent: number, page: number) => {
      const normalizedHash = (fileHash ?? "").toLowerCase();
      if (normalizedHash) {
        upsert(normalizedHash, { cfi, percent });
      }
      const persist = saveReadingProgressForBook(bookId, { cfi, percent }).catch((err: unknown) =>
        console.error("Failed to save reading progress to ledger:", err),
      );

      // 每 N 页静默触发一次同步
      if (page > 0 && lastAutoUploadPageRef.current > 0) {
        if (Math.abs(page - lastAutoUploadPageRef.current) >= PAGE_AUTO_UPLOAD_DELTA) {
          lastAutoUploadPageRef.current = page;
          void useSyncStore.getState().syncOnBackground?.();
        }
      } else {
        lastAutoUploadPageRef.current = page;
      }
      return persist;
    },
    [bookId, fileHash, upsert],
  );

  const writeLedgerRef = useRef(writeLedger);
  writeLedgerRef.current = writeLedger;

  const throttledWrite = useRef(
    throttle((cfi: string, percent: number, page: number) => {
      writeLedger(cfi, percent, page);
    }, 5000),
  ).current;

  const onRelocate = useCallback(
    (fraction: number | null | undefined, cfi: string, page: number) => {
      if (!cfi) return;
      if (!progressSettledRef.current) {
        // 稳定窗口判定: 连续同 cfi 或 1.5s 超时视为稳定
        const settledByRepetition = cfi === loadedCfiBaseRef.current;
        const settledByTimeout = Date.now() >= progressSettleDeadlineRef.current;
        if (settledByRepetition || settledByTimeout) {
          progressSettledRef.current = true;
          loadedCfiBaseRef.current = cfi;
          settledFractionRef.current = fraction ?? 0;
        } else {
          loadedCfiBaseRef.current = cfi;
        }
      }

      if (progressSettledRef.current) {
        const fractionJump = Math.abs((fraction ?? 0) - settledFractionRef.current);
        if (!progressWrittenRef.current && cfi === loadedCfiBaseRef.current) {
          // 初始位置未变，不产生伪更新
        } else if (fractionJump < PROGRESS_WRITE_MIN_DELTA) {
          // 渲染引擎浮点抖动，不视为翻页
        } else {
          progressWrittenRef.current = true;
          pendingWriteRef.current = { cfi, percent: fraction ?? 0, page };
          throttledWrite(cfi, fraction ?? 0, page);
        }
      }
    },
    [throttledWrite],
  );

  /** 打开书时调用: 重置并启动 1.5s 稳定窗口 */
  const startOpenSession = useCallback(() => {
    progressSettledRef.current = false;
    progressWrittenRef.current = false;
    progressSettleDeadlineRef.current = Date.now() + 1500;
    settledFractionRef.current = 0;
    lastAutoUploadPageRef.current = 0;
  }, []);

  /** 恢复阅读位置: 直读账本，无记录时回退到旧书本元数据兜底 */
  const getRestoreCfi = useCallback(async (): Promise<string | null> => {
    const normalizedHash = (fileHash ?? "").toLowerCase();
    if (normalizedHash) {
      try {
        const row = await getReadingProgressForBook(normalizedHash);
        if (row?.cfi) return row.cfi;
      } catch (err) {
        console.error("Failed to read reading progress:", err);
      }
    }
    // 兼容回退: 旧版本未入账本时尝试从 books 记录恢复
    const oldBook = useLibraryStore.getState().books.find((b) => b.id === bookId);
    if (oldBook?.currentCfi) {
      return oldBook.currentCfi;
    }
    return null;
  }, [bookId, fileHash]);

  /** 进后台: 触发静默同步并刷新账本 */
  const onBackground = useCallback(() => {
    void useSyncStore.getState().syncOnBackground?.();
    const normalizedHash = (fileHash ?? "").toLowerCase();
    if (normalizedHash) {
      void useProgressStore.getState().refreshOne(normalizedHash);
    }
  }, [fileHash]);

  /** 退书或切换书籍: 强制 Flush 最新未落盘的翻页并触发同步 */
  const flushOnUnmount = useCallback(() => {
    const pending = pendingWriteRef.current;
    if (!pending) {
      void useSyncStore.getState().syncNow?.();
      return;
    }
    pendingWriteRef.current = null;
    const latest = pending;
    void (async () => {
      await writeLedgerRef.current(latest.cfi, latest.percent, latest.page);
      void useSyncStore.getState().syncNow?.();
    })();
  }, []);

  const getWrittenFlag = useCallback(() => progressWrittenRef.current, []);

  return useMemo(
    () => ({
      onRelocate,
      startOpenSession,
      getRestoreCfi,
      onBackground,
      flushOnUnmount,
      getWrittenFlag,
    }),
    [onRelocate, startOpenSession, getRestoreCfi, onBackground, flushOnUnmount, getWrittenFlag],
  );
}
