/**
 * 桌面端「本机书源」生命周期 Hook
 * 监听 useDeveloperStore 中的 isDeveloperMode / localOpdsServer。
 *
 * 桌面端【不真起 HTTP 服务】:本机书源是自用闭环(app 自己访问自己),
 * 全部请求都在 TauriPlatformService.fetch 里进程内短路直接调 handler ——
 * 不经 TCP,也就免疫 Clash/TUN/系统代理拦回环那一跳(2026-09-12)。
 * 书源表里那个 127.0.0.1:19090 因此只是【虚拟地址】:不占端口,
 * 也不会和 LAN 同步抢 Rust 端 start_lan_server 的单例槽位。
 *
 * 服务器代码没有扔:core 的 createLocalOpdsRequestHandler + 驱动装配照旧,
 * 只是把「监听端口」换成「注册 handler」。将来真要对外提供,加回一行 startLANServer 即可。
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getPlatformService } from "@readany/core/services";
import { useDriverConfigStore } from "@readany/core/sources/driver/driver-config-store";
import {
  createLocalOpdsRequestHandler,
  type LocalOpdsDriver,
} from "@readany/core/sources/driver/local-opds-server";
import { ZlibDriver } from "@readany/core/sources/driver/zlib";
import { LibgenDriver } from "@readany/core/sources/driver/libgen";
import { useOpdsSourcesStore } from "@readany/core/sources/opds-source-store";
import { useDeveloperStore } from "@/stores/developer-store";

export const DESKTOP_LOCAL_OPDS_SOURCE_ID = "local-opds-server";
/** 虚拟端口:桌面端不真绑端口,仅用于书源 URL 与短路匹配 */
const DESKTOP_LOCAL_OPDS_VIRTUAL_PORT = 19090;
/** 本机书源的源地址(短路按它精确匹配,避免误劫持别的 localhost OPDS 源) */
const DESKTOP_LOCAL_OPDS_ORIGIN = `http://127.0.0.1:${DESKTOP_LOCAL_OPDS_VIRTUAL_PORT}`;

let builtRev: string | null = null;
let desktopLifecycle: Promise<void> = Promise.resolve();
let desktopGeneration = 0;

/** 驱动配置版本串(与 hook 依赖同构;在 hydrate 之后读取才是有效值) */
function currentDesktopRev(): string {
  const z = useDriverConfigStore.getState().zlib;
  return `${z.enabled}|${z.domain}|${z.authId}|${z.username}|${z.hasPassword}`;
}

function enqueueDesktop(task: () => Promise<void>): void {
  desktopLifecycle = desktopLifecycle.then(task, task).catch((e) => {
    console.warn("[DesktopLocalOpds] lifecycle task failed:", e);
  });
}

/** 注销进程内 handler(幂等) */
function unregisterHandler(): void {
  getPlatformService().setLocalOpdsHandler?.(null);
  builtRev = null;
}

export function useDesktopLocalOpdsServer() {
  const isDeveloperMode = useDeveloperStore((s) => s.isDeveloperMode);
  const localOpdsServer = useDeveloperStore((s) => s.localOpdsServer);
  const zlConfig = useDriverConfigStore((s) => s.zlib);
  const zlConfigRev = `${zlConfig.enabled}|${zlConfig.domain}|${zlConfig.authId}|${zlConfig.username}|${zlConfig.hasPassword}`;
  const { t } = useTranslation();

  const shouldRun = isDeveloperMode && localOpdsServer;

  useEffect(() => {
    const myGen = ++desktopGeneration;

    enqueueDesktop(async () => {
      if (myGen !== desktopGeneration) return;

      if (!shouldRun) {
        unregisterHandler();
        const existing = useOpdsSourcesStore
          .getState()
          .sources.find((s) => s.id === DESKTOP_LOCAL_OPDS_SOURCE_ID);
        if (existing) {
          void useOpdsSourcesStore.getState().removeSource(DESKTOP_LOCAL_OPDS_SOURCE_ID);
        }
        return;
      }

      const platform = getPlatformService();
      if (!platform.setLocalOpdsHandler) {
        console.warn("[DesktopLocalOpds] setLocalOpdsHandler not available on platform");
        return;
      }

      // hydrate 会改写 driver-config store(进而触发本 effect 重跑);
      // 读 rev 必须在 hydrate 之后,这样"hydrate 触发的重跑"能命中 rev 未变 → 不重建
      await useDriverConfigStore.getState().hydrate();
      if (myGen !== desktopGeneration) return;
      const rev = currentDesktopRev();

      if (builtRev !== rev) {
        try {
          const drivers: LocalOpdsDriver[] = [new LibgenDriver()];
          const currentZl = useDriverConfigStore.getState().zlib;

          if (currentZl.enabled) {
            const password = await useDriverConfigStore.getState().getZlibPassword();
            const userKey = await useDriverConfigStore.getState().getZlibUserKey();
            drivers.push(
              new ZlibDriver({
                domain: currentZl.domain.trim() || undefined,
                username: currentZl.username.trim() || "",
                password: password || "",
                ...(currentZl.authId && userKey
                  ? { auth: { id: currentZl.authId, key: userKey } }
                  : {}),
              }),
            );
          }

          if (myGen !== desktopGeneration) return;
          platform.setLocalOpdsHandler(createLocalOpdsRequestHandler(drivers), DESKTOP_LOCAL_OPDS_ORIGIN);
          builtRev = rev;
          console.log("[DesktopLocalOpds] in-process handler registered (no port bound)");
        } catch (err) {
          console.error("[DesktopLocalOpds] failed to build local OPDS handler:", err);
          return;
        }
      }

      await useOpdsSourcesStore.getState().hydrate();
      await useOpdsSourcesStore.getState().saveSource(
        {
          id: DESKTOP_LOCAL_OPDS_SOURCE_ID,
          name: t("library.opdsLocalServerSourceName", "本机书源 (Z-Library / LibGen)"),
          url: `${DESKTOP_LOCAL_OPDS_ORIGIN}/opds/`,
          username: "",
          allowInsecure: true,
        },
        "",
      );
    });
  }, [shouldRun, zlConfigRev, t]);

  // 组件卸载(应用退出)时注销 handler
  useEffect(() => {
    return () => {
      unregisterHandler();
    };
  }, []);
}
