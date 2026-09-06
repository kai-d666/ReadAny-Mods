/**
 * 本机书源服务端(实验性,开发者模式)生命周期 hook(2026-09-06):
 * devFlags.localOpdsServer 开启 → 127.0.0.1 起本地 OPDS 服务(内置上游 driver)
 * → 自动注册一条「本机书源」到书源列表;关闭/组件卸载 → 停服并摘除书源。
 * 端口 19090 起可配失败自动探测;仅绑定 loopback(其他设备不可达)。
 */
import { getPlatformService } from "@readany/core/services";
import { createLocalOpdsRequestHandler } from "@readany/core/sources/driver/local-opds-server";
import { LibgenDriver } from "@readany/core/sources/driver/libgen";
import { useOpdsSourcesStore } from "@readany/core/sources/opds-source-store";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useSettingsStore } from "@/stores/settings-store";

export const LOCAL_OPDS_SOURCE_ID = "local-opds-server";
const LOCAL_OPDS_PORT_START = 19090;
const LOCAL_OPDS_PORT_END = 19110;

export function useLocalOpdsServer() {
  const enabled = useSettingsStore((s) => s.devFlags.localOpdsServer);
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
      const drivers = [new LibgenDriver()];
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
  }, [enabled, t]);
}
