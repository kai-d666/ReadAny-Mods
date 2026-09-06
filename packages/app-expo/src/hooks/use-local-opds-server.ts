/**
 * 本机书源服务端(实验性,开发者模式)生命周期 hook(2026-09-06):
 * devFlags.localOpdsServer 开启 → 127.0.0.1 起本地 OPDS 服务(内置上游 driver)
 * → 自动注册一条「本机书源」到书源列表;关闭/组件卸载 → 停服并摘除书源。
 * 端口 19090 起可配失败自动探测;仅绑定 loopback(其他设备不可达)。
 */
import { getPlatformService } from "@readany/core/services";
import { useDriverConfigStore } from "@readany/core/sources/driver/driver-config-store";
import {
  createLocalOpdsRequestHandler,
  type LocalOpdsDriver,
} from "@readany/core/sources/driver/local-opds-server";
import { LibgenDriver } from "@readany/core/sources/driver/libgen";
import { ZlibDriver } from "@readany/core/sources/driver/zlib";
import { useOpdsSourcesStore } from "@readany/core/sources/opds-source-store";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useSettingsStore } from "@/stores/settings-store";

export const LOCAL_OPDS_SOURCE_ID = "local-opds-server";
const LOCAL_OPDS_PORT_START = 19090;
const LOCAL_OPDS_PORT_END = 19110;

export function useLocalOpdsServer() {
  const enabled = useSettingsStore((s) => s.devFlags.localOpdsServer);
  // 驱动配置(token 可含链接里的认证信息)变化时立即重建服务(免手动重启服务开关)
  const zlConfig = useDriverConfigStore((s) => s.zlib);
  const zlConfigRev = `${zlConfig.enabled}|${zlConfig.domain}|${zlConfig.authId}`;
  const { t } = useTranslation();

  useEffect(() => {
    let disposed = false;
    let running: { port: number; server: unknown } | null = null;

    async function start() {
      const platform = getPlatformService();
      if (!platform.startLANServer) {
        console.warn("[LocalOpds] startLANServer is not available on this platform");
        return;
      }
      const drivers: LocalOpdsDriver[] = [new LibgenDriver()];
      // 可配置驱动注册表:已启用且配置完整的 Z-Library 一并挂载
      // (remix 链接认证优先;无则回退邮箱密码登录)
      await useDriverConfigStore.getState().hydrate();
      const zlConfig = useDriverConfigStore.getState().zlib;
      if (zlConfig.enabled && zlConfig.domain) {
        try {
          const userKey = await useDriverConfigStore.getState().getZlibUserKey();
          const password = await useDriverConfigStore.getState().getZlibPassword();
          drivers.push(
            new ZlibDriver({
              domain: zlConfig.domain,
              username: zlConfig.username,
              password,
              ...(zlConfig.authId && userKey
                ? { auth: { id: zlConfig.authId, key: userKey } }
                : {}),
            }),
          );
        } catch (error) {
          console.warn("[LocalOpds] zlib driver disabled:", error);
        }
      }
      const handler = createLocalOpdsRequestHandler(drivers);

      for (let port = LOCAL_OPDS_PORT_START; port <= LOCAL_OPDS_PORT_END; port++) {
        try {
          running = await platform.startLANServer(port, handler, "127.0.0.1");
          console.log(`[LocalOpds] server started on 127.0.0.1:${running.port}`);
          break;
        } catch {
          console.warn(`[LocalOpds] port ${port} unavailable, trying next…`);
        }
      }
      if (!running || disposed) return;

      await useOpdsSourcesStore.getState().hydrate();
      if (disposed) return;
      await useOpdsSourcesStore.getState().saveSource(
        {
          id: LOCAL_OPDS_SOURCE_ID,
          name: t("library.opdsLocalServerSourceName", "本机书源服务"),
          url: `http://127.0.0.1:${running.port}/opds/`,
          username: "",
          allowInsecure: true,
        },
        "",
      );
    }

    async function stop() {
      if (running) {
        await getPlatformService()
          .stopLANServer?.(running.server)
          .catch(() => {});
        running = null;
      }
      await useOpdsSourcesStore
        .getState()
        .removeSource(LOCAL_OPDS_SOURCE_ID)
        .catch(() => {});
    }

    if (enabled) void start();
    return () => {
      disposed = true;
      void stop();
    };
  }, [enabled, zlConfigRev, t]);
}
