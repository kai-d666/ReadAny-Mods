/**
 * OPDS 书源列表 store —— zustand + 平台 kv(SecureStore)。
 *
 * 数据布局(每条源独立 key,规避 SecureStore 单 key 大小限制):
 *   opds_sources               → JSON string[](index,书源 id 列表)
 *   opds_source_{id}           → JSON OpdsSource(不含密码本体)
 *   opds_source_password_{id}  → 密码明文(SecureStore 内,与同步凭据同源策略)
 *
 * 密码编辑语义:saveSource(source, "") 表示"保持原密码不变"(表单留空)。
 */

import { create } from "zustand";
import { getPlatformService } from "../services/platform";
import { OPDS_SOURCE_LIST_KEY, opdsSourceSecretKey, type OpdsSource } from "./opds";

export const OPDS_SOURCE_KEY_PREFIX = "opds_source_";
export const OPDS_MAX_SOURCES = 50;

export function opdsSourceKey(id: string): string {
  return `${OPDS_SOURCE_KEY_PREFIX}${id}`;
}

export interface OpdsSourcesState {
  sources: OpdsSource[];
  loaded: boolean;
  /** 全量读入(幂等:会话内只执行一次;编辑通过 saveSource 更新内存) */
  hydrate(): Promise<void>;
  getSource(id: string): OpdsSource | undefined;
  /** 读某书源的密码明文(构造 OpdsClient / 下载认证用) */
  getPassword(id: string): Promise<string>;
  /** upsert;password 非空则覆盖密码,为空且已有书源则保留原密码 */
  saveSource(source: OpdsSource, password: string): Promise<void>;
  removeSource(id: string): Promise<void>;
  /** 除错/调试:清空全部书源数据 */
  clearAll(): Promise<void>;
}

export const useOpdsSourcesStore = create<OpdsSourcesState>((set, get) => ({
  sources: [],
  loaded: false,

  async hydrate() {
    if (get().loaded) return;
    const platform = getPlatformService();

    let ids: string[] = [];
    try {
      const raw = await platform.kvGetItem(OPDS_SOURCE_LIST_KEY);
      ids = raw ? (JSON.parse(raw) as string[]) : [];
      if (!Array.isArray(ids)) ids = [];
    } catch (error) {
      console.warn("[OpdsSources] ignoring invalid stored source index:", error);
    }

    const sources: OpdsSource[] = [];
    for (const id of ids) {
      try {
        const rawSource = await platform.kvGetItem(opdsSourceKey(id));
        if (!rawSource) continue;
        const parsed = JSON.parse(rawSource) as OpdsSource;
        if (!parsed.id || !parsed.url) continue;
        const hasPassword = (await platform.kvGetItem(opdsSourceSecretKey(id))) != null;
        sources.push({ ...parsed, hasPassword });
      } catch (error) {
        console.warn(`[OpdsSources] ignoring invalid stored source ${id}:`, error);
      }
    }
    set({ sources, loaded: true });
  },

  getSource(id) {
    return get().sources.find((source) => source.id === id);
  },

  async getPassword(id) {
    const platform = getPlatformService();
    return (await platform.kvGetItem(opdsSourceSecretKey(id))) ?? "";
  },

  async saveSource(source, password) {
    const platform = getPlatformService();
    const existing = get().sources.find((item) => item.id === source.id);
    const trimmed = { ...source, username: (source.username ?? "").trim() };

    // 持久化本体(不含 hasPassword —— 内存标记,hydrate 时重算)
    const { hasPassword: _ignored, ...persisted } = trimmed;
    await platform.kvSetItem(opdsSourceKey(source.id), JSON.stringify(persisted));

    if (password) {
      await platform.kvSetItem(opdsSourceSecretKey(source.id), password);
    }

    // 新书源 → 追加索引(上限保护)
    if (!existing) {
      let ids: string[] = [];
      try {
        const raw = await platform.kvGetItem(OPDS_SOURCE_LIST_KEY);
        ids = raw ? (JSON.parse(raw) as string[]) : [];
        if (!Array.isArray(ids)) ids = [];
      } catch {
        // 索引损坏 → 重建为当前内存列表(崩溃后兜底)
        ids = get().sources.map((item) => item.id);
      }
      if (!ids.includes(source.id)) {
        if (ids.length >= OPDS_MAX_SOURCES) {
          throw new Error(`OPDS sources limit reached (${OPDS_MAX_SOURCES})`);
        }
        ids.push(source.id);
        await platform.kvSetItem(OPDS_SOURCE_LIST_KEY, JSON.stringify(ids));
      }
    }

    // 内存:upsert(编辑保留原 hasPassword;新增按是否有密码)
    const next = existing
      ? get().sources.map((item) =>
          item.id === source.id ? { ...trimmed, hasPassword: existing.hasPassword || !!password } : item,
        )
      : [...get().sources, { ...trimmed, hasPassword: !!password }];
    set({ sources: next });
  },

  async removeSource(id) {
    const platform = getPlatformService();
    await platform.kvRemoveItem(opdsSourceKey(id));
    await platform.kvRemoveItem(opdsSourceSecretKey(id));

    const remaining = get().sources.filter((item) => item.id !== id);
    await platform.kvSetItem(
      OPDS_SOURCE_LIST_KEY,
      JSON.stringify(remaining.map((item) => item.id)),
    );
    set({ sources: remaining });
  },

  async clearAll() {
    const platform = getPlatformService();
    for (const id of get().sources.map((item) => item.id)) {
      await platform.kvRemoveItem(opdsSourceKey(id));
      await platform.kvRemoveItem(opdsSourceSecretKey(id));
    }
    await platform.kvSetItem(OPDS_SOURCE_LIST_KEY, JSON.stringify([]));
    set({ sources: [], loaded: true });
  },
}));
