/**
 * 进度账本钩子(2026-09-06 重构 B):进度相关的全部防抖/记账/上传逻辑收编于此。
 *
 * 架构(单写入口):
 * - 唯一写入口 = 节流 5s 落盘(reading_progress);稳定窗口/抖动过滤在写之前判断
 *   "这帧算不算真实翻页",节流只管"合并频率"。
 * - 兜底(后台/退书)只"读账 → 刷 progressStore → 上传",不独立取值。
 * - 书库/统计/AI 一律经 useProgressStore 直读;Book.progress 不再读写(桌面端保留)。
 *
 * ReaderScreen 只需调用:
 *   onRelocate(fraction, cfi)  — 翻页/跳转/恢复帧(内部判定 settle/抖动/写账)
 *   startOpenSession()         — 打开书时重置并启动稳定窗口
 *   getRestoreCfi()            — 恢复位置(直读账本)
 *   onBackground()             — 进后台:只读账+只推自己
 *   flushOnUnmount()           — 退书页:只上传(账本已由节流维护)
 *   getWrittenFlag()           — 本次是否已真实写入(远端进度"本机动作优先"判断)
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { throttle } from "@readany/core/utils/throttle";
import {
  getReadingProgressForBook,
  saveReadingProgressForBook,
} from "@readany/core/db/progress-queries";
import { useSyncStore } from "@readany/core/stores/sync-store";
import { useProgressStore } from "@readany/core/stores/progress-store";

/** 渲染器抖动阈值(相对 settle 基准 fraction):稳定后 ±0.1% 级波动不算翻页 */
const PROGRESS_WRITE_MIN_DELTA = 0.001;
/** KOReader 式"每 N 页推送":页码变化累计达到 N 页就静默上传一次快照 */
const PAGE_AUTO_UPLOAD_DELTA = 5;

export function useProgressLedger(
  bookId: string,
  fileHash: string | null | undefined,
) {
  const upsert = useProgressStore((s) => s.upsert);

  // 伪写抑制状态(全部收编,组件不再持有)
  const loadedCfiBaseRef = useRef<string | null>(null);
  const progressSettledRef = useRef(false);
  const progressSettleDeadlineRef = useRef(0);
  const progressWrittenRef = useRef(false);
  const settledFractionRef = useRef(0);
  const lastAutoUploadPageRef = useRef(0);

  // 换书重置(与原组件 useEffect([bookId]) 等价)
  useEffect(() => {
    loadedCfiBaseRef.current = null;
    progressSettledRef.current = false;
    progressSettleDeadlineRef.current = 0;
    progressWrittenRef.current = false;
    settledFractionRef.current = 0;
    lastAutoUploadPageRef.current = 0;
  }, [bookId]);

  const writeLedger = useCallback(
    (cfi: string, percent: number, page: number) => {
      // 唯一写入口:reading_progress + 内存进度 store(不落 books 表)
      upsert(fileHash, { cfi, percent });
      void saveReadingProgressForBook(bookId, { cfi, percent }).catch((err: Error) =>
        console.error("Failed to save reading progress:", err),
      );
      // 阅读中定期推送:每 N 页(页码累计差)静默上传一次快照
      if (page > 0 && lastAutoUploadPageRef.current > 0) {
        if (Math.abs(page - lastAutoUploadPageRef.current) >= PAGE_AUTO_UPLOAD_DELTA) {
          lastAutoUploadPageRef.current = page;
          void useSyncStore.getState().syncOnBackground?.();
        }
      } else {
        lastAutoUploadPageRef.current = page;
      }
    },
    [bookId, fileHash, upsert],
  );

  const throttledWrite = useRef(
    throttle((cfi: string, percent: number, page: number) => writeLedger(cfi, percent, page), 5000),
  ).current;

  const onRelocate = useCallback(
    (fraction: number | null | undefined, cfi: string, page: number) => {
      if (!cfi) return;
      if (!progressSettledRef.current) {
        // 稳定窗口:连续同 cfi 或 1.5s 超时 → 进入稳定;之前为过渡帧,不写
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
        // 抖动判定以 settle 基准为参照(相对差 <0.1% 不写;与 0 比会把抖动误判为翻页)
        const fractionJump = Math.abs((fraction ?? 0) - settledFractionRef.current);
        if (!progressWrittenRef.current && cfi === loadedCfiBaseRef.current) {
          // 位置未变:不产生伪更新
        } else if (fractionJump < PROGRESS_WRITE_MIN_DELTA) {
          // 渲染器抖动帧:不视为翻页(用户主动跳转是真实动作,与其他帧一样处理)
        } else {
          progressWrittenRef.current = true;
          throttledWrite(cfi, fraction ?? 0, page);
        }
      }
    },
    [throttledWrite],
  );

  /** 打开书:重置并启动 1.5s 稳定窗口(过渡帧不算真实翻页) */
  const startOpenSession = useCallback(() => {
    progressSettledRef.current = false;
    progressWrittenRef.current = false;
    progressSettleDeadlineRef.current = Date.now() + 1500;
    settledFractionRef.current = 0;
    lastAutoUploadPageRef.current = 0;
  }, []);

  /** 恢复位置:直读账本(唯一);无记录 → null(渲染器默认首页) */
  const getRestoreCfi = useCallback(async (): Promise<string | null> => {
    if (!fileHash) return null;
    try {
      const row = await getReadingProgressForBook(fileHash);
      return row?.cfi || null;
    } catch (err) {
      console.error("Failed to read reading progress:", err);
      return null;
    }
  }, [fileHash]);

  /** 进后台:只读账(刷 progressStore)+ 只推自己;不独立取值 */
  const onBackground = useCallback(() => {
    void useSyncStore.getState().syncOnBackground?.();
    if (fileHash) {
      void useProgressStore.getState().refreshOne(fileHash);
    }
  }, [fileHash]);

  /** 退书页:只上传既有账(节流已维护),不写值 */
  const flushOnUnmount = useCallback(() => {
    void useSyncStore.getState().syncNow?.();
  }, []);

  /** 本次是否已真实写入(远端进度应用时"本机动作优先") */
  const getWrittenFlag = useCallback(() => progressWrittenRef.current, []);

  // 稳定引用(依赖全部 useCallback,引用稳定;避免消费者 effect 反复重建)
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
