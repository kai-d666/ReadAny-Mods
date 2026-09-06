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

/**
 * 从平台 kv 列出全部书源数据键(排除密码键),按 id 排序 ——
 * 索引(opds_sources)可能被竞态/损坏覆盖,数据键才是唯一事实源;
 * 索引只作加速层,读不到时一律以全量扫描重建。
 */
async function listStoredSourceIds(): Promise<string[]> {
  const platform = getPlatformService();
  try {
    const keys = await platform.kvGetAllKeys();
    return keys
      .filter(
        (key) =>
          key.startsWith(OPDS_SOURCE_KEY_PREFIX) && !key.includes("password"),
      )
      .map((key) => key.slice(OPDS_SOURCE_KEY_PREFIX.length))
      .sort();
  } catch {
    return [];
  }
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
    // 索引自愈:数据键集合与索引不一致时,以数据键为准修正索引
    const storedIds = await listStoredSourceIds();
    if (storedIds.length !== ids.length || storedIds.some((id) => !ids.includes(id))) {
      ids = storedIds;
      await platform.kvSetItem(OPDS_SOURCE_LIST_KEY, JSON.stringify(ids));
      console.warn(`[OpdsSources] index healed to ${ids.length} stored source(s)`);
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
    console.log(
      `[OpdsSources] hydrate: index=${ids.length} sources=${sources.map((s) => s.name).join(", ")}`,
    );
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

    // 新书源:先做上限检查 + 更新索引(必须在写数据键之前 ——
    // 数据键一旦写入,listStoredSourceIds 会包含自身,限制检查即失效)
    if (!existing) {
      const ids = await listStoredSourceIds();
      if (!ids.includes(source.id)) {
        if (ids.length >= OPDS_MAX_SOURCES) {
          throw new Error(`OPDS sources limit reached (${OPDS_MAX_SOURCES})`);
        }
        ids.push(source.id);
      }
      await platform.kvSetItem(OPDS_SOURCE_LIST_KEY, JSON.stringify(ids));
    }

    // 持久化本体(不含 hasPassword —— 内存标记,hydrate 时重算)
    const { hasPassword: _ignored, ...persisted } = trimmed;
    await platform.kvSetItem(opdsSourceKey(source.id), JSON.stringify(persisted));

    if (password) {
      await platform.kvSetItem(opdsSourceSecretKey(source.id), password);
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

    // 索引从剩余数据键重建(不再依赖内存,防"只删成空索引")
    const ids = await listStoredSourceIds();
    await platform.kvSetItem(OPDS_SOURCE_LIST_KEY, JSON.stringify(ids));
    set({ sources: get().sources.filter((item) => item.id !== id) });
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
