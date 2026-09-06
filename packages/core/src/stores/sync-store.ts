/**
 * Shared sync store — manages sync configuration and state for multiple backends.
 * Supports WebDAV, S3, and LAN sync.
 * Used by both desktop (Tauri) and mobile (Expo).
 */

import { create } from "zustand";
import { emitLibraryChanged } from "../events/library-events";
import { getPlatformService } from "../services/platform";
import { sanitizeS3RemoteRoot } from "../sync/s3-paths";
import type { S3Config, SyncConfig, WebDavConfig } from "../sync/sync-backend";
import {
  DEFAULT_S3_REMOTE_ROOT,
  DEFAULT_SYNC_CONFIG,
  DEFAULT_WEBDAV_REMOTE_ROOT,
  SYNC_ACTIVE_BACKEND_KEY,
  SYNC_BACKEND_CONFIG_KEYS,
  SYNC_CONFIG_KEY,
  SYNC_SECRET_KEYS,
} from "../sync/sync-backend";
import type { ISyncBackend } from "../sync/sync-backend";
import { createSyncBackend, getSecretKeyForBackend } from "../sync/sync-backend-factory";
import type { SyncDirection, SyncProgress, SyncResult, SyncStatusType } from "../sync/sync-types";
import {
  cleanupGhostBooks,
  dedupeDuplicateBooksByHash,
} from "../sync/book-dedupe";
import type { DedupeBooksReport, GhostCleanupReport } from "../sync/book-dedupe";
import type { CloudBookEntry } from "../sync/cloud-library";
import { sanitizeWebDavRemoteRoot, sanitizeWebDavUrl } from "../sync/webdav-client";
import { hasRemoteChanges, uploadOwnSnapshot } from "../sync/simple-sync";
import { eventBus } from "../utils/event-bus";
import { useProgressStore } from "./progress-store";

let activeSyncPromise: Promise<SyncResult | null> | null = null;
const SYNC_RUNTIME_STATE_KEY = "sync_runtime_state";

interface PersistedSyncRuntimeState {
  lastSyncAt: number | null;
  lastResult: SyncResult | null;
}

function runWithSyncLock(task: () => Promise<SyncResult | null>): Promise<SyncResult | null> {
  if (activeSyncPromise) return activeSyncPromise;

  activeSyncPromise = task().finally(() => {
    activeSyncPromise = null;
  });

  return activeSyncPromise;
}

async function flushPendingReadingSession(): Promise<void> {
  try {
    const { useReadingSessionStore } = await import("./reading-session-store");
    console.log("[SyncStore] Flushing pending reading session before sync...");
    await useReadingSessionStore.getState().saveCurrentSession();
    console.log("[SyncStore] Pending reading session flushed.");
  } catch (error) {
    console.warn("[SyncStore] Failed to flush reading session before sync:", error);
  }
}

function notifyLibraryStateChanged(): void {
  try {
    emitLibraryChanged();
  } catch (error) {
    console.warn("[SyncStore] Failed to notify library refresh after sync:", error);
  }
}

function notifySyncCompleted(timestamp: number): void {
  try {
    eventBus.emit("sync:completed", { timestamp });
  } catch (error) {
    console.warn("[SyncStore] Failed to emit sync completion event:", error);
  }
}

async function loadPersistedSyncRuntimeState(): Promise<PersistedSyncRuntimeState> {
  try {
    const platform = getPlatformService();
    const raw = await platform.kvGetItem(SYNC_RUNTIME_STATE_KEY);
    if (!raw) {
      return { lastSyncAt: null, lastResult: null };
    }

    const parsed = JSON.parse(raw) as PersistedSyncRuntimeState;
    return {
      lastSyncAt: typeof parsed.lastSyncAt === "number" ? parsed.lastSyncAt : null,
      lastResult: parsed.lastResult ?? null,
    };
  } catch (err) {
    console.warn("[Sync] Failed to load persisted sync runtime state:", err);
    return { lastSyncAt: null, lastResult: null };
  }
}

async function persistSyncRuntimeState(state: PersistedSyncRuntimeState): Promise<void> {
  try {
    const platform = getPlatformService();
    await platform.kvSetItem(SYNC_RUNTIME_STATE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn("[SyncStore] Failed to persist sync runtime state:", error);
  }
}

export interface SyncState {
  // Config
  config: SyncConfig | null;
  isConfigured: boolean;
  backendType: "webdav" | "s3" | "lan" | null;
  /** 云端书目 hash 缓存(绑定角标数据源):云书库页/上传后刷新;null=未知 */
  cloudHashes: string[] | null;
  setCloudHashes: (hashes: string[] | null) => void;

  // Runtime state
  status: SyncStatusType;
  lastSyncAt: number | null;
  lastResult: SyncResult | null;
  error: string | null;
  progress: SyncProgress | null;
  /** 同步详细日志(开发者横幅用;最近 100 条) */
  syncTrace: { ts: number; text: string }[];

  // Conflict resolution
  pendingDirection: SyncDirection | null;

  // Actions
  loadConfig: () => Promise<void>;
  loadBackendConfig: (type: "webdav" | "s3") => Promise<SyncConfig | null>;

  // WebDAV actions
  saveWebDavConfig: (
    url: string,
    username: string,
    password: string,
    allowInsecure?: boolean,
    remoteRoot?: string,
  ) => Promise<void>;
  testWebDavConnection: (
    url: string,
    username: string,
    password: string,
    allowInsecure?: boolean,
    remoteRoot?: string,
  ) => Promise<boolean>;

  // S3 actions
  saveS3Config: (
    config: Omit<
      S3Config,
      "type" | "autoSync" | "syncIntervalMins" | "wifiOnly" | "notifyOnComplete"
    >,
    secretAccessKey: string,
  ) => Promise<void>;
  testS3Connection: (
    config: Omit<
      S3Config,
      "type" | "autoSync" | "syncIntervalMins" | "wifiOnly" | "notifyOnComplete"
    >,
    secretAccessKey: string,
  ) => Promise<boolean>;

  // Sync actions
  syncNow: (
    resolvedDirection?: "upload" | "download",
    useIncremental?: boolean,
  ) => Promise<SyncResult | null>;
  /** stat 探测版同步:快照未变则跳过完整同步(打开书场景) */
  probeAndSyncNow: () => Promise<SyncResult | null>;
  /** 后台专用:仅上传本机快照(滑走 App 窗口,~300ms) */
  syncOnBackground: () => Promise<SyncResult | null>;
  /** 清理云端幽灵(remote 无文件、新云端目录不存在的记录)+ 存量重复书 */
  cleanupGhosts: () => Promise<
    { ghost: GhostCleanupReport; dedupe: DedupeBooksReport } | { error: string }
  >;
  /** 云书库:列出云端书目(本地已有同 hash 书 → localBookId) */
  listCloudBooks: () => Promise<CloudBookEntry[] | { error: string }>;
  /** 云书库:上传一本书到云端(绑定);已存在同 hash → skipped */
  uploadCloudBook: (
    bookId: string,
  ) => Promise<{ ok: boolean; error?: string; skipped?: boolean } | { error: string }>;
  /** 云书库:下载云端书文件到本地临时文件(交由 UI 走导入去重入库) */
  downloadCloudBook: (
    fileHash: string,
  ) => Promise<{ ok: boolean; error?: string; localPath?: string; fileName?: string } | { error: string }>;
  /** 云书库:删除云端书(文件+封面) */
  deleteCloudBook: (
    fileHash: string,
  ) => Promise<{ ok: boolean; error?: string } | { error: string }>;
  /** Run sync using an explicitly provided backend (e.g. for LAN sync) */
  syncWithBackend: (
    backend: ISyncBackend,
    resolvedDirection?: "upload" | "download",
    useIncremental?: boolean,
  ) => Promise<SyncResult | null>;
  /** New simplified sync (JSON-based, no full db file sync) */
  syncSimple: (
    backend: ISyncBackend,
    resolvedDirection?: "upload" | "download",
  ) => Promise<SyncResult | null>;
  forceFullSync: (direction: "upload" | "download") => Promise<SyncResult | null>;
  setAutoSync: (enabled: boolean) => Promise<void>;
  setSyncIntervalMins: (minutes: number) => Promise<void>;
  setWifiOnly: (enabled: boolean) => Promise<void>;
  setNotifyOnComplete: (enabled: boolean) => Promise<void>;
  resetSync: () => Promise<void>;
}

/** 取已配置的 backend;未配置/凭据缺失 → 统一错误对象(云书库 4 个 action 共用) */
async function requireConfiguredBackend(
  state: SyncState,
): Promise<ISyncBackend | { error: string }> {
  if (!state.isConfigured || !state.config) return { error: "Sync not configured" };
  const platform = getPlatformService();
  const secretKey =
    state.config.type !== "lan" ? getSecretKeyForBackend(state.config.type) : null;
  const secret = secretKey ? await platform.kvGetItem(secretKey) : null;
  if (state.config.type !== "lan" && !secret) return { error: "No credentials configured" };
  try {
    return createSyncBackend(state.config, secret || "");
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function normalizeSyncConfig(config: SyncConfig): SyncConfig {
  if (config.type === "webdav") {
    return {
      ...config,
      url: sanitizeWebDavUrl(config.url),
      username: config.username.trim(),
      remoteRoot:
        sanitizeWebDavRemoteRoot(config.remoteRoot ?? DEFAULT_WEBDAV_REMOTE_ROOT) ||
        DEFAULT_WEBDAV_REMOTE_ROOT,
    };
  }
  if (config.type === "s3") {
    return {
      ...config,
      remoteRoot:
        sanitizeS3RemoteRoot(config.remoteRoot ?? DEFAULT_S3_REMOTE_ROOT) || DEFAULT_S3_REMOTE_ROOT,
    };
  }
  return config;
}

function isPersistableBackendType(value: unknown): value is "webdav" | "s3" {
  return value === "webdav" || value === "s3";
}

function withDefaultSyncConfig(config: SyncConfig): SyncConfig {
  return config.type === "webdav" || config.type === "s3"
    ? ({ ...DEFAULT_SYNC_CONFIG, ...config } as SyncConfig)
    : config;
}

async function loadStoredBackendConfig(type: "webdav" | "s3"): Promise<SyncConfig | null> {
  const platform = getPlatformService();
  const raw = await platform.kvGetItem(SYNC_BACKEND_CONFIG_KEYS[type]);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SyncConfig;
    if (parsed.type !== type) return null;
    return withDefaultSyncConfig(normalizeSyncConfig(parsed));
  } catch (error) {
    console.warn(`[SyncStore] Ignoring invalid stored ${type} config:`, error);
    return null;
  }
}

async function persistBackendConfig(config: WebDavConfig | S3Config): Promise<void> {
  const platform = getPlatformService();
  const normalizedConfig = normalizeSyncConfig(config) as WebDavConfig | S3Config;
  const serialized = JSON.stringify(normalizedConfig);
  await platform.kvSetItem(SYNC_BACKEND_CONFIG_KEYS[normalizedConfig.type], serialized);
  await platform.kvSetItem(SYNC_ACTIVE_BACKEND_KEY, normalizedConfig.type);
  // Keep the legacy key as an active-config mirror for older builds and migration.
  await platform.kvSetItem(SYNC_CONFIG_KEY, serialized);
}

async function migrateLegacySyncConfig(): Promise<{
  activeType: "webdav" | "s3" | null;
  activeConfig: SyncConfig | null;
}> {
  const platform = getPlatformService();
  const activeTypeRaw = await platform.kvGetItem(SYNC_ACTIVE_BACKEND_KEY);
  const legacyConfigStr = await platform.kvGetItem(SYNC_CONFIG_KEY);
  console.log(
    `[SyncStore] loadConfig: activeBackend = ${activeTypeRaw ?? "none"}, legacyConfig = ${
      legacyConfigStr ? "found" : "not found"
    }`,
  );

  let legacyConfig: SyncConfig | null = null;
  if (legacyConfigStr) {
    legacyConfig = withDefaultSyncConfig(
      normalizeSyncConfig(JSON.parse(legacyConfigStr) as SyncConfig),
    );
    if (legacyConfig.type === "webdav" || legacyConfig.type === "s3") {
      const backendKey = SYNC_BACKEND_CONFIG_KEYS[legacyConfig.type];
      const existingBackendConfig = await platform.kvGetItem(backendKey);
      if (!existingBackendConfig) {
        await platform.kvSetItem(backendKey, JSON.stringify(legacyConfig));
      }
      if (!isPersistableBackendType(activeTypeRaw)) {
        await platform.kvSetItem(SYNC_ACTIVE_BACKEND_KEY, legacyConfig.type);
      }
    }
  }

  const activeType = isPersistableBackendType(activeTypeRaw)
    ? activeTypeRaw
    : legacyConfig?.type === "webdav" || legacyConfig?.type === "s3"
      ? legacyConfig.type
      : null;
  if (!activeType) return { activeType: null, activeConfig: null };

  const activeConfig =
    (await loadStoredBackendConfig(activeType)) ??
    (legacyConfig?.type === activeType ? legacyConfig : null);
  return { activeType, activeConfig };
}

async function persistCurrentConfigUpdate(config: SyncConfig): Promise<void> {
  if (config.type !== "webdav" && config.type !== "s3") return;
  await persistBackendConfig(config);
}

async function getExistingBackendConfig(type: "webdav" | "s3"): Promise<SyncConfig | null> {
  const current = useSyncStore.getState().config;
  if (current?.type === type) return current;
  return loadStoredBackendConfig(type);
}

export const useSyncStore = create<SyncState>((set, get) => ({
  config: null,
  isConfigured: false,
  backendType: null,
  cloudHashes: null,
  setCloudHashes: (hashes) => set({ cloudHashes: hashes }),
  status: "idle",
  lastSyncAt: null,
  lastResult: null,
  error: null,
  progress: null,
  syncTrace: [],
  pendingDirection: null,

  loadConfig: async () => {
    try {
      const { activeConfig } = await migrateLegacySyncConfig();
      if (activeConfig) {
        const config = activeConfig;
        await persistCurrentConfigUpdate(config);
        const platform = getPlatformService();
        const secretKey = config.type !== "lan" ? getSecretKeyForBackend(config.type) : null;
        const secret = secretKey ? await platform.kvGetItem(secretKey) : null;
        console.log(`[SyncStore] loadConfig: secret = ${secret ? "found" : "not found"}`);

        const isConfigured =
          config.type === "lan"
            ? true
            : !!(
                secret &&
                ((config.type === "webdav" && config.url && config.username) ||
                  (config.type === "s3" && config.endpoint && config.bucket && config.accessKeyId))
              );

        console.log(
          `[SyncStore] loadConfig: isConfigured = ${isConfigured}, backendType = ${config.type}`,
        );
        const runtimeState = await loadPersistedSyncRuntimeState();
        set({
          config,
          isConfigured,
          backendType: config.type,
          lastSyncAt: runtimeState.lastSyncAt,
          lastResult: runtimeState.lastResult,
        });
      } else {
        const runtimeState = await loadPersistedSyncRuntimeState();
        set({
          lastSyncAt: runtimeState.lastSyncAt,
          lastResult: runtimeState.lastResult,
        });
      }
    } catch (e) {
      console.error("[SyncStore] loadConfig error:", e);
    }
  },

  loadBackendConfig: async (type) => {
    try {
      return await loadStoredBackendConfig(type);
    } catch (error) {
      console.warn(`[SyncStore] Failed to load ${type} config:`, error);
      return null;
    }
  },

  saveWebDavConfig: async (url, username, password, allowInsecure, remoteRoot) => {
    const platform = getPlatformService();
    const existing = await getExistingBackendConfig("webdav");
    const config: WebDavConfig = {
      type: "webdav",
      url: sanitizeWebDavUrl(url),
      username: username.trim(),
      remoteRoot:
        sanitizeWebDavRemoteRoot(
          remoteRoot ?? (existing as WebDavConfig)?.remoteRoot ?? DEFAULT_WEBDAV_REMOTE_ROOT,
        ) || DEFAULT_WEBDAV_REMOTE_ROOT,
      allowInsecure: allowInsecure ?? (existing as WebDavConfig)?.allowInsecure ?? false,
      autoSync: (existing as WebDavConfig)?.autoSync ?? DEFAULT_SYNC_CONFIG.autoSync,
      syncIntervalMins:
        (existing as WebDavConfig)?.syncIntervalMins ?? DEFAULT_SYNC_CONFIG.syncIntervalMins,
      wifiOnly: (existing as WebDavConfig)?.wifiOnly ?? DEFAULT_SYNC_CONFIG.wifiOnly,
      notifyOnComplete:
        (existing as WebDavConfig)?.notifyOnComplete ?? DEFAULT_SYNC_CONFIG.notifyOnComplete,
    };
    console.log("[SyncStore] saveWebDavConfig: saving config...");
    await persistBackendConfig(config);
    await platform.kvSetItem(SYNC_SECRET_KEYS.webdav, password);

    // Verify save
    const savedPassword = await platform.kvGetItem(SYNC_SECRET_KEYS.webdav);
    console.log(
      `[SyncStore] saveWebDavConfig: credential save = ${savedPassword ? "ok" : "FAILED"}`,
    );

    set({ config, isConfigured: true, backendType: "webdav" });
  },

  testWebDavConnection: async (url, username, password, allowInsecure, remoteRoot) => {
    const backend = createSyncBackend(
      {
        type: "webdav",
        url: sanitizeWebDavUrl(url),
        username: username.trim(),
        remoteRoot:
          sanitizeWebDavRemoteRoot(remoteRoot ?? DEFAULT_WEBDAV_REMOTE_ROOT) ||
          DEFAULT_WEBDAV_REMOTE_ROOT,
        allowInsecure: allowInsecure ?? false,
        autoSync: false,
        syncIntervalMins: DEFAULT_SYNC_CONFIG.syncIntervalMins,
        wifiOnly: DEFAULT_SYNC_CONFIG.wifiOnly,
        notifyOnComplete: DEFAULT_SYNC_CONFIG.notifyOnComplete,
      },
      password,
    );
    return backend.testConnection();
  },

  saveS3Config: async (s3Config, secretAccessKey) => {
    const platform = getPlatformService();
    const existing = await getExistingBackendConfig("s3");
    const config: S3Config = {
      ...s3Config,
      type: "s3",
      remoteRoot:
        sanitizeS3RemoteRoot(
          s3Config.remoteRoot ?? (existing as S3Config)?.remoteRoot ?? DEFAULT_S3_REMOTE_ROOT,
        ) || DEFAULT_S3_REMOTE_ROOT,
      autoSync: (existing as S3Config)?.autoSync ?? DEFAULT_SYNC_CONFIG.autoSync,
      syncIntervalMins:
        (existing as S3Config)?.syncIntervalMins ?? DEFAULT_SYNC_CONFIG.syncIntervalMins,
      wifiOnly: (existing as S3Config)?.wifiOnly ?? DEFAULT_SYNC_CONFIG.wifiOnly,
      notifyOnComplete:
        (existing as S3Config)?.notifyOnComplete ?? DEFAULT_SYNC_CONFIG.notifyOnComplete,
    };
    await persistBackendConfig(config);
    await platform.kvSetItem(SYNC_SECRET_KEYS.s3, secretAccessKey);
    set({ config, isConfigured: true, backendType: "s3" });
  },

  testS3Connection: async (s3Config, secretAccessKey) => {
    try {
      const config: S3Config = {
        ...s3Config,
        type: "s3",
        remoteRoot:
          sanitizeS3RemoteRoot(s3Config.remoteRoot ?? DEFAULT_S3_REMOTE_ROOT) ||
          DEFAULT_S3_REMOTE_ROOT,
        autoSync: false,
        syncIntervalMins: 30,
        wifiOnly: false,
        notifyOnComplete: true,
      };
      const backend = createSyncBackend(config, secretAccessKey);
      return backend.testConnection();
    } catch (err) {
      console.warn("[Sync] S3 connection test failed:", err);
      return false;
    }
  },

  syncNow: async (resolvedDirection, _useIncremental) => {
    const currentState = get();
    if (currentState.status !== "idle" && currentState.status !== "error") {
      return activeSyncPromise;
    }

    return runWithSyncLock(async () => {
      const state = get();
      if (!state.isConfigured || !state.config) {
        set({ error: "Sync not configured" });
        return null;
      }

      const platform = getPlatformService();
      const secretKey =
        state.config.type !== "lan" ? getSecretKeyForBackend(state.config.type) : null;
      const secret = secretKey ? await platform.kvGetItem(secretKey) : null;

      if (state.config.type !== "lan" && !secret) {
        set({ error: "No credentials configured" });
        return null;
      }

      if (state.config.type !== "lan" && "wifiOnly" in state.config && state.config.wifiOnly) {
        if (platform.isOnWifi) {
          const isWifi = await platform.isOnWifi();
          if (!isWifi) {
            set({ error: "Sync skipped: WiFi-only mode is enabled and device is not on WiFi" });
            return null;
          }
        }
      }

      try {
        await flushPendingReadingSession();
        set({ status: "checking", error: null, pendingDirection: null });
        set((s) => ({
          syncTrace: [...s.syncTrace.slice(-99), { ts: Date.now(), text: "开始同步(完整)" }],
        }));
        const backend = createSyncBackend(state.config, secret || "");

        const connected = await backend.testConnection();
        if (!connected) {
          const connectionError = "无法连接到同步服务器，请检查网络和凭据";
          const result: SyncResult = {
            success: false,
            direction: "none",
            filesUploaded: 0,
            filesDownloaded: 0,
            filesUploadFailed: 0,
            filesDownloadFailed: 0,
            durationMs: 0,
            error: connectionError,
          };
          set({
            status: "error",
            error: connectionError,
            pendingDirection: null,
            progress: null,
            lastResult: result,
          });
          await persistSyncRuntimeState({
            lastSyncAt: get().lastSyncAt,
            lastResult: result,
          });
          return result;
        }

        set({ error: null });

        const result = await get().syncSimple(backend, resolvedDirection);
        if (!result) {
          set({ status: "idle", progress: null, pendingDirection: null });
        } else {
          set((s) => ({
            syncTrace: [
              ...s.syncTrace.slice(-99),
              {
                ts: Date.now(),
                text: result.success ? "同步完成 ✅" : `同步失败: ${result.error ?? "未知"}`,
              },
            ],
          }));
          await persistSyncRuntimeState({
            lastSyncAt: get().lastSyncAt,
            lastResult: get().lastResult,
          });
        }
        return result;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const result: SyncResult = {
          success: false,
          direction: "none",
          filesUploaded: 0,
          filesDownloaded: 0,
          filesUploadFailed: 0,
          filesDownloadFailed: 0,
          durationMs: 0,
          error,
        };
        set({ status: "error", error, pendingDirection: null, progress: null, lastResult: result });
        await persistSyncRuntimeState({
          lastSyncAt: get().lastSyncAt,
          lastResult: result,
        });
        return result;
      }
    });
  },

  /**
   * stat 探测版同步(2026-09-06):先 1-2 个最小请求列远端快照,比较 lastModified —
   * 无变化 → 返回(null,不跑完整同步);变化/首次/探测失败 → 完整 syncNow。
   * 依据:坚果云无 ETag 且条件请求被忽略(实测),业界无 ETag 时的标准
   * fallback 即目录统计比较(ownCloud Efficient Stat Polling)。
   */
  probeAndSyncNow: async () => {
    const currentState = get();
    if (!currentState.isConfigured || !currentState.config) return null;
    if (currentState.status !== "idle" && currentState.status !== "error") {
      return activeSyncPromise;
    }
    try {
      const platform = getPlatformService();
      const secretKey =
        currentState.config.type !== "lan"
          ? getSecretKeyForBackend(currentState.config.type)
          : null;
      const secret = secretKey ? await platform.kvGetItem(secretKey) : null;
      if (currentState.config.type !== "lan" && !secret) return null;
      const backend = createSyncBackend(currentState.config, secret || "");
      const changed = await hasRemoteChanges(backend);
      if (!changed) {
        console.log("[SyncStore] stat probe: remote snapshots unchanged, skip full sync");
        set((s) => ({
          syncTrace: [
            ...s.syncTrace.slice(-99),
            { ts: Date.now(), text: "探测:远端无变化,跳过完整同步" },
          ],
        }));
        return null;
      }
    } catch (e) {
      // 探测失败(断网等)保守走完整同步,不丢功能
      console.warn("[SyncStore] stat probe failed, falling back to full sync:", e);
    }
    return get().syncNow();
  },

  /** 后台专用:只上传本机快照(跳过"先拉后推"的拉取),滑走窗口 ~300ms 完成 */
  syncOnBackground: async () => {
    const currentState = get();
    if (!currentState.isConfigured || !currentState.config) return null;
    if (currentState.status !== "idle" && currentState.status !== "error") {
      return activeSyncPromise;
    }
    try {
      const platform = getPlatformService();
      const secretKey =
        currentState.config.type !== "lan"
          ? getSecretKeyForBackend(currentState.config.type)
          : null;
      const secret = secretKey ? await platform.kvGetItem(secretKey) : null;
      if (currentState.config.type !== "lan" && !secret) return null;
      const backend = createSyncBackend(currentState.config, secret || "");
      await uploadOwnSnapshot(backend);
      console.log("[SyncStore] background quick upload done");
      set((s) => ({
        syncTrace: [
          ...s.syncTrace.slice(-99),
          { ts: Date.now(), text: "后台快推完成 ✅(只推自己)" },
        ],
      }));
    } catch (e) {
      // 上传失败不致命:快照全量,下次任意同步整体补传
      console.warn("[SyncStore] background quick upload failed (will retry on next sync):", e);
    }
    return null;
  },

  syncWithBackend: async (backend, resolvedDirection, _useIncremental = true) => {
    const state = get();
    if (state.status !== "idle" && state.status !== "error") {
      return activeSyncPromise;
    }

    return runWithSyncLock(async () => {
      try {
        await flushPendingReadingSession();
        set({ status: "checking", error: null, pendingDirection: null });
        const result = await get().syncSimple(backend, resolvedDirection);
        if (!result) {
          set({ status: "idle", progress: null, pendingDirection: null });
        } else {
          set((s) => ({
            syncTrace: [
              ...s.syncTrace.slice(-99),
              {
                ts: Date.now(),
                text: result.success ? "同步完成 ✅" : `同步失败: ${result.error ?? "未知"}`,
              },
            ],
          }));
          await persistSyncRuntimeState({
            lastSyncAt: get().lastSyncAt,
            lastResult: get().lastResult,
          });
        }
        return result;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const result: SyncResult = {
          success: false,
          direction: "none",
          filesUploaded: 0,
          filesDownloaded: 0,
          filesUploadFailed: 0,
          filesDownloadFailed: 0,
          durationMs: 0,
          error,
        };
        set({ status: "error", error, pendingDirection: null, progress: null, lastResult: result });
        await persistSyncRuntimeState({
          lastSyncAt: get().lastSyncAt,
          lastResult: result,
        });
        return result;
      }
    });
  },

  cleanupGhosts: async () => {
    const state = get();
    if (!state.isConfigured || !state.config) return { error: "Sync not configured" };
    const platform = getPlatformService();
    const secretKey =
      state.config.type !== "lan" ? getSecretKeyForBackend(state.config.type) : null;
    const secret = secretKey ? await platform.kvGetItem(secretKey) : null;
    if (state.config.type !== "lan" && !secret) return { error: "No credentials configured" };
    try {
      const backend = createSyncBackend(state.config, secret || "");
      const ghost = await cleanupGhostBooks(backend);
      const dedupe = await dedupeDuplicateBooksByHash();
      return { ghost, dedupe };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },

  /** 构造已配置的 sync backend;未配置/无凭据 → { error } */
  listCloudBooks: async () => {
    const state = get();
    const backend = await requireConfiguredBackend(state);
    if ("error" in backend) return backend;
    try {
      const { listRemoteBooks } = await import("../sync/cloud-library");
      const entries = await listRemoteBooks(backend);
      set({ cloudHashes: entries.map((e) => e.fileHash) });
      return entries;
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },

  uploadCloudBook: async (bookId) => {
    const state = get();
    const backend = await requireConfiguredBackend(state);
    if ("error" in backend) return backend;
    try {
      const { uploadBookToCloud } = await import("../sync/cloud-library");
      return await uploadBookToCloud(backend, bookId);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },

  downloadCloudBook: async (fileHash) => {
    const state = get();
    const backend = await requireConfiguredBackend(state);
    if ("error" in backend) return backend;
    try {
      const { downloadRemoteBookToLocal } = await import("../sync/cloud-library");
      return await downloadRemoteBookToLocal(backend, fileHash);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },

  deleteCloudBook: async (fileHash) => {
    const state = get();
    const backend = await requireConfiguredBackend(state);
    if ("error" in backend) return backend;
    try {
      const { deleteRemoteBookFromCloud } = await import("../sync/cloud-library");
      return await deleteRemoteBookFromCloud(backend, fileHash);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },

  syncSimple: async (backend: ISyncBackend, resolvedDirection?: "upload" | "download") => {
    const state = get();
    // syncSimple is usually entered right after a successful connection check,
    // so allow both "idle" and "checking" as valid entry states.
    if (state.status !== "idle" && state.status !== "checking") return null;

    set({ status: "syncing-files", error: null, progress: null });

    try {
      const { runSimpleSync } = await import("../sync/simple-sync");

      const receiveOnly = backend.type === "lan" || resolvedDirection === "download";
      const uploadOnly = resolvedDirection === "upload";
      const result = await runSimpleSync(
        backend,
        (progress) => {
          set({ progress });
          set((s) => ({
            syncTrace: [...s.syncTrace.slice(-99), { ts: Date.now(), text: progress.message }],
          }));
        },
        receiveOnly
          ? {
              receiveOnly: true,
              forceApply: true,
              fileSyncOptions: {
                downloadRemoteBooks: true,
                disableUploads: true,
                disableRemoteDeletes: true,
              },
            }
          : uploadOnly
            ? {
                fileSyncOptions: {
                  forceUploadAll: true,
                },
              }
            : undefined,
      );

      if (result.success) {
        const syncedAt = Date.now();
        const direction = receiveOnly ? ("download" as const) : ("upload" as const);
        set({
          status: "idle",
          lastSyncAt: syncedAt,
          lastResult: {
            success: true,
            direction,
            filesUploaded: result.filesUploaded,
            filesDownloaded: result.filesDownloaded,
            filesUploadFailed: result.filesUploadFailed,
            filesDownloadFailed: result.filesDownloadFailed,
            durationMs: 0,
          },
          error: null,
          progress: null,
        });
        notifyLibraryStateChanged();
        notifySyncCompleted(syncedAt);
        await persistSyncRuntimeState({
          lastSyncAt: syncedAt,
          lastResult: {
            success: true,
            direction,
            filesUploaded: result.filesUploaded,
            filesDownloaded: result.filesDownloaded,
            filesUploadFailed: result.filesUploadFailed,
            filesDownloadFailed: result.filesDownloadFailed,
            durationMs: 0,
          },
        });
        // 同步完成后刷新绑定角标缓存(云端 hash 集合);静默失败,不影响主流程
        void get().listCloudBooks().catch(() => null);
      } else {
        set({
          status: "error",
          lastResult: {
            success: false,
            direction: "none",
            filesUploaded: 0,
            filesDownloaded: 0,
            filesUploadFailed: 0,
            filesDownloadFailed: 0,
            durationMs: 0,
            error: result.error || "同步失败",
          },
          error: result.error || "同步失败",
          progress: null,
        });
        await persistSyncRuntimeState({
          lastSyncAt: get().lastSyncAt,
          lastResult: {
            success: false,
            direction: "none",
            filesUploaded: 0,
            filesDownloaded: 0,
            filesUploadFailed: 0,
            filesDownloadFailed: 0,
            durationMs: 0,
            error: result.error || "同步失败",
          },
        });
      }

      return {
        success: result.success,
        direction: receiveOnly ? ("download" as const) : ("upload" as const),
        filesUploaded: result.filesUploaded,
        filesDownloaded: result.filesDownloaded,
        filesUploadFailed: result.filesUploadFailed,
        filesDownloadFailed: result.filesDownloadFailed,
        durationMs: 0,
        error: result.error,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set({
        status: "error",
        lastResult: {
          success: false,
          direction: "none",
          filesUploaded: 0,
          filesDownloaded: 0,
          filesUploadFailed: 0,
          filesDownloadFailed: 0,
          durationMs: 0,
          error,
        },
        error,
        progress: null,
      });
      await persistSyncRuntimeState({
        lastSyncAt: get().lastSyncAt,
        lastResult: {
          success: false,
          direction: "none",
          filesUploaded: 0,
          filesDownloaded: 0,
          filesUploadFailed: 0,
          filesDownloadFailed: 0,
          durationMs: 0,
          error,
        },
      });
      return {
        success: false,
        direction: "none" as const,
        filesUploaded: 0,
        filesDownloaded: 0,
        filesUploadFailed: 0,
        filesDownloadFailed: 0,
        durationMs: 0,
        error,
      };
    }
  },

  forceFullSync: async (direction) => {
    const state = get();
    if (state.status !== "idle" && state.status !== "error") {
      return activeSyncPromise;
    }
    if (!state.isConfigured || !state.config) {
      set({ error: "Sync not configured" });
      return null;
    }

    const platform = getPlatformService();
    const secretKey =
      state.config.type !== "lan" ? getSecretKeyForBackend(state.config.type) : null;
    const secret = secretKey ? await platform.kvGetItem(secretKey) : null;

    if (state.config.type !== "lan" && !secret) {
      set({ error: "No credentials configured" });
      return null;
    }

    if (state.config.type !== "lan" && "wifiOnly" in state.config && state.config.wifiOnly) {
      if (platform.isOnWifi) {
        const isWifi = await platform.isOnWifi();
        if (!isWifi) {
          set({ error: "Sync skipped: WiFi-only mode is enabled and device is not on WiFi" });
          return null;
        }
      }
    }

    const config = state.config;

    return runWithSyncLock(async () => {
      try {
        await flushPendingReadingSession();
        set({ status: "checking", error: null, pendingDirection: null, progress: null });
        const backend = createSyncBackend(config, secret || "");
        const connected = await backend.testConnection();

        if (!connected) {
          const connectionError = "无法连接到同步服务器，请检查网络和凭据";
          const result: SyncResult = {
            success: false,
            direction: "none",
            filesUploaded: 0,
            filesDownloaded: 0,
            filesUploadFailed: 0,
            filesDownloadFailed: 0,
            durationMs: 0,
            error: connectionError,
          };
          set({
            status: "error",
            error: connectionError,
            pendingDirection: null,
            progress: null,
            lastResult: result,
          });
          await persistSyncRuntimeState({
            lastSyncAt: get().lastSyncAt,
            lastResult: result,
          });
          return result;
        }

        const { runSimpleSync } = await import("../sync/simple-sync");

        set({ status: "syncing-files", error: null, progress: null });

        const receiveOnly = direction === "download";
        const startTime = Date.now();
        const simpleResult = await runSimpleSync(
          backend,
          (progress) => {
            set({
              status: "syncing-files",
              progress,
            });
          },
          {
            receiveOnly,
            forceApply: receiveOnly,
            fileSyncOptions:
              direction === "upload"
                ? { forceUploadAll: true }
                : {
                    forceDownloadAll: true,
                    downloadRemoteBooks: true,
                    disableUploads: true,
                    disableRemoteDeletes: true,
                  },
          },
        );

        const result: SyncResult = {
          success: simpleResult.success,
          direction,
          filesUploaded: simpleResult.filesUploaded,
          filesDownloaded: simpleResult.filesDownloaded,
          filesUploadFailed: simpleResult.filesUploadFailed,
          filesDownloadFailed: simpleResult.filesDownloadFailed,
          durationMs: Date.now() - startTime,
          error: simpleResult.error,
        };

        notifyLibraryStateChanged();
        // 进度唯一读模型内存重载(2026-09-07 修复):拉取合并会更新 reading_progress
        // (云端其他设备的新进度),而 progress-store 的 entries 只 hydrate 于启动时刻
        // → 云书库/书库角标停留在旧值(实测:同步后仍是 2%,DB 其实已是 29%)。
        try {
          await useProgressStore.getState().hydrate();
        } catch (error) {
          console.warn("[SyncStore] progress hydrate after sync failed:", error);
        }

        if (result.success) {
          const syncedAt = Date.now();
          set({
            status: "idle",
            lastSyncAt: syncedAt,
            lastResult: result,
            error: null,
            progress: null,
            pendingDirection: null,
          });
          notifySyncCompleted(syncedAt);
          await persistSyncRuntimeState({
            lastSyncAt: syncedAt,
            lastResult: result,
          });
        } else {
          set({
            status: "error",
            lastResult: result,
            error: result.error || "同步失败",
            progress: null,
            pendingDirection: null,
          });
          await persistSyncRuntimeState({
            lastSyncAt: get().lastSyncAt,
            lastResult: result,
          });
        }

        return result;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const result: SyncResult = {
          success: false,
          direction,
          filesUploaded: 0,
          filesDownloaded: 0,
          filesUploadFailed: 0,
          filesDownloadFailed: 0,
          durationMs: 0,
          error,
        };
        set({
          status: "error",
          lastResult: result,
          error,
          progress: null,
          pendingDirection: null,
        });
        await persistSyncRuntimeState({
          lastSyncAt: get().lastSyncAt,
          lastResult: result,
        });
        return result;
      }
    });
  },

  setAutoSync: async (enabled) => {
    const state = get();
    if (!state.config) return;
    const config = { ...state.config, autoSync: enabled };
    await persistCurrentConfigUpdate(config);
    set({ config });
  },

  setSyncIntervalMins: async (minutes) => {
    const state = get();
    if (!state.config || state.config.type === "lan") return;

    const clampedMinutes = Math.max(
      5,
      Math.min(720, Math.round(minutes || DEFAULT_SYNC_CONFIG.syncIntervalMins)),
    );
    const config = { ...state.config, syncIntervalMins: clampedMinutes };
    await persistCurrentConfigUpdate(config);
    set({ config });
  },

  setWifiOnly: async (enabled) => {
    const state = get();
    if (!state.config) return;
    const config = { ...state.config, wifiOnly: enabled };
    await persistCurrentConfigUpdate(config);
    set({ config });
  },

  setNotifyOnComplete: async (enabled) => {
    const state = get();
    if (!state.config) return;
    const config = { ...state.config, notifyOnComplete: enabled };
    await persistCurrentConfigUpdate(config);
    set({ config });
  },

  resetSync: async () => {
    const platform = getPlatformService();
    await platform.kvRemoveItem(SYNC_CONFIG_KEY);
    await platform.kvRemoveItem(SYNC_ACTIVE_BACKEND_KEY);
    await platform.kvRemoveItem(SYNC_BACKEND_CONFIG_KEYS.webdav);
    await platform.kvRemoveItem(SYNC_BACKEND_CONFIG_KEYS.s3);
    await platform.kvRemoveItem(SYNC_SECRET_KEYS.webdav);
    await platform.kvRemoveItem(SYNC_SECRET_KEYS.s3);
    await platform.kvRemoveItem(SYNC_RUNTIME_STATE_KEY);
    set({
      config: null,
      isConfigured: false,
      backendType: null,
      status: "idle",
      lastSyncAt: null,
      lastResult: null,
      error: null,
      progress: null,
      pendingDirection: null,
    });
  },
}));
