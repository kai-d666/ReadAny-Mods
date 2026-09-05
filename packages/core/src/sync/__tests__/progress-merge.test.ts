/**
 * reading_progress 合并语义回归(2026-09-06 定稿)
 * 与其余记录表一致:LWW(时间戳裁决)。
 * - 旧时间戳的小进度(另一设备的旧记录)不会覆盖新进度;
 * - 新时间戳的小进度(用户真实重读)被接受——与 Whispersync/Koodo 语义一致;
 * - 伪写(打开未翻页刷新时间戳)在写入侧(稳定帧+未动不写+抖动阈值)堵死,
 *   因此不再需要"只进不退"这条过度防御(它会让重读位置无法传播)。
 * 本文件随实现保留为语义锚点;若未来刻意改回 monotonic 语义,先改这里。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { shouldApplyRemoteRecord } = await import("../simple-sync");

function localState(timestamp: number) {
  return { timestamp, deletedAt: undefined };
}

describe("sync reading_progress merge (LWW, per-record)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("本地无记录 → 应用", () => {
    const record = { book_hash: "h", percent: 0.5, updated_at: 100 };
    expect(shouldApplyRemoteRecord("reading_progress", record, "updated_at", undefined)).toBe(true);
  });

  it("重读场景:远端小进度 + 新时间戳 → 应用(真实重读应传播)", () => {
    const record = { book_hash: "h", percent: 0.02, updated_at: 200 };
    expect(
      shouldApplyRemoteRecord("reading_progress", record, "updated_at", localState(100)),
    ).toBe(true);
  });

  it("旧记录场景:远端小进度 + 旧时间戳 → 拒绝(不能覆盖新进度)", () => {
    const record = { book_hash: "h", percent: 0.05, updated_at: 50 };
    expect(
      shouldApplyRemoteRecord("reading_progress", record, "updated_at", localState(100)),
    ).toBe(false);
  });

  it("远端大进度:新时间戳 → 应用;旧时间戳 → 拒绝", () => {
    const newer = { book_hash: "h", percent: 0.8, updated_at: 200 };
    expect(
      shouldApplyRemoteRecord("reading_progress", newer, "updated_at", localState(100)),
    ).toBe(true);
    const older = { book_hash: "h", percent: 0.8, updated_at: 50 };
    expect(
      shouldApplyRemoteRecord("reading_progress", older, "updated_at", localState(100)),
    ).toBe(false);
  });

  it("时间戳相等(无 deleted_at 时)→ 拒绝(防重复应用)", () => {
    const record = { book_hash: "h", percent: 0.5, updated_at: 100 };
    expect(
      shouldApplyRemoteRecord("reading_progress", record, "updated_at", localState(100)),
    ).toBe(false);
  });

  it("非 reading_progress 表不受影响:仍走时间戳 LWW", () => {
    const record = { id: "x", updated_at: 200 };
    expect(shouldApplyRemoteRecord("highlights", record, "updated_at", localState(100))).toBe(true);
    const older = { id: "x2", updated_at: 50 };
    expect(shouldApplyRemoteRecord("highlights", older, "updated_at", localState(100))).toBe(false);
  });
});
