/**
 * 内置书源服务端的驱动配置 store(2026-09-06):
 * 每个驱动器(如 Z-Library)的可选配置 —— 域名/账号(启用开关)等;
 * 密码本体走平台 kv secret 分键(与书源/同步凭据同策略)。
 */

import { create } from "zustand";
import { getPlatformService } from "../../services/platform";

export interface ZlibDriverConfig {
  enabled: boolean;
  /** ZL 个人/官方域名,如 singlelogin.me(下载必需个人域名) */
  domain: string;
  username: string;
  /** remix 认证方案:userid(专属链接 ?remix_userid=…) */
  authId: string;
  /** 仅供 UI 回显 */
  hasPassword: boolean;
  hasUserKey: boolean;
}

const ZLIB_CONFIG_KEY = "localopds_driver_zlib";
const ZLIB_PASSWORD_KEY = "localopds_driver_zlib_password";
const ZLIB_USERKEY_KEY = "localopds_driver_zlib_userkey";

export const DEFAULT_ZLIB_CONFIG: ZlibDriverConfig = {
  enabled: false,
  domain: "",
  username: "",
  authId: "",
  hasPassword: false,
  hasUserKey: false,
};

/** 从专属链接(/?remix_userid=…&remix_userkey=…)解析出域与认证 */
export function parseZlibAccessLink(
  link: string,
): { domain: string; authId: string; authKey: string } | null {
  try {
    const url = new URL(link.trim());
    const authId = url.searchParams.get("remix_userid") ?? "";
    const authKey = url.searchParams.get("remix_userkey") ?? "";
    if (!url.hostname || !authId || !authKey) return null;
    return { domain: url.hostname, authId, authKey };
  } catch {
    return null;
  }
}

export interface DriverConfigState {
  zlib: ZlibDriverConfig;
  loaded: boolean;
  hydrate(): Promise<void>;
  /** password/userKey 非空则覆盖 secret;留空保持原值 */
  saveZlib(
    config: Omit<ZlibDriverConfig, "hasPassword" | "hasUserKey">,
    secrets: { password?: string; userKey?: string },
  ): Promise<void>;
  getZlibPassword(): Promise<string>;
  getZlibUserKey(): Promise<string>;
}

export const useDriverConfigStore = create<DriverConfigState>((set, get) => ({
  zlib: DEFAULT_ZLIB_CONFIG,
  loaded: false,

  async hydrate() {
    if (get().loaded) return;
    const platform = getPlatformService();
    let config = DEFAULT_ZLIB_CONFIG;
    try {
      const raw = await platform.kvGetItem(ZLIB_CONFIG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ZlibDriverConfig>;
        config = {
          enabled: !!parsed.enabled,
          domain: typeof parsed.domain === "string" ? parsed.domain : "",
          username: typeof parsed.username === "string" ? parsed.username : "",
          authId: typeof parsed.authId === "string" ? parsed.authId : "",
          hasPassword: false,
          hasUserKey: false,
        };
      }
    } catch {
      // 损坏配置回退默认
    }
    const hasPassword = (await platform.kvGetItem(ZLIB_PASSWORD_KEY)) != null;
    const hasUserKey = (await platform.kvGetItem(ZLIB_USERKEY_KEY)) != null;
    set({ zlib: { ...config, hasPassword, hasUserKey }, loaded: true });
  },

  async saveZlib(config, secrets) {
    const platform = getPlatformService();
    const next: ZlibDriverConfig = {
      ...config,
      hasPassword: get().zlib.hasPassword || !!secrets.password,
      hasUserKey: get().zlib.hasUserKey || !!secrets.userKey || !!config.authId,
    };
    await platform.kvSetItem(ZLIB_CONFIG_KEY, JSON.stringify(config));
    if (secrets.password) {
      await platform.kvSetItem(ZLIB_PASSWORD_KEY, secrets.password);
    }
    if (secrets.userKey) {
      await platform.kvSetItem(ZLIB_USERKEY_KEY, secrets.userKey);
    }
    set({ zlib: next });
  },

  async getZlibPassword() {
    const platform = getPlatformService();
    return (await platform.kvGetItem(ZLIB_PASSWORD_KEY)) ?? "";
  },

  async getZlibUserKey() {
    const platform = getPlatformService();
    return (await platform.kvGetItem(ZLIB_USERKEY_KEY)) ?? "";
  },
}));
