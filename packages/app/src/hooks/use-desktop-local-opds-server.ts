/**
 * 桌面端本机书源服务端生命周期 Hook
 * 监听 useDeveloperStore 中的 isDeveloperMode 和 localOpdsServer
 * 当开启时，在 127.0.0.1:19090 启动内置 OPDS 网关，并自动向 OPDS 书源注册「本机书源」
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
const DESKTOP_LOCAL_OPDS_PORT = 19090;

let activeDesktopServer: { port: number; server: unknown } | null = null;
let builtDesktopRev: string | null = null;
let desktopLifecycle: Promise<void> = Promise.resolve();
let desktopGeneration = 0;

function currentDesktopRev(): string {
  const z = useDriverConfigStore.getState().zlib;
  return `${z.enabled}|${z.domain}|${z.authId}|${z.username}|${z.hasPassword}`;
}

function enqueueDesktop(task: () => Promise<void>): void {
  desktopLifecycle = desktopLifecycle.then(task, task).catch((e) => {
    console.warn("[DesktopLocalOpds] lifecycle task failed:", e);
  });
}

async function stopActiveDesktopServer(): Promise<void> {
  if (!activeDesktopServer) return;
  const s = activeDesktopServer;
  activeDesktopServer = null;
  builtDesktopRev = null;
  try {
    await getPlatformService().stopLANServer?.(s.server);
  } catch {
    // ignore
  }
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
        await stopActiveDesktopServer();
        const existing = useOpdsSourcesStore.getState().sources.find((s) => s.id === DESKTOP_LOCAL_OPDS_SOURCE_ID);
        if (existing) {
          void useOpdsSourcesStore.getState().removeSource(DESKTOP_LOCAL_OPDS_SOURCE_ID);
        }
        return;
      }

      const platform = getPlatformService();
      if (!platform.startLANServer) {
        console.warn("[DesktopLocalOpds] startLANServer not available on platform");
        return;
      }

      await useDriverConfigStore.getState().hydrate();
      if (myGen !== desktopGeneration) return;
      const rev = currentDesktopRev();

      if (activeDesktopServer && builtDesktopRev === rev) {
        // 只需确保源存在
        await useOpdsSourcesStore.getState().hydrate();
        await useOpdsSourcesStore.getState().saveSource(
          {
            id: DESKTOP_LOCAL_OPDS_SOURCE_ID,
            name: t("library.opdsLocalServerSourceName", "本机书源 (Z-Library / LibGen)"),
            url: `http://127.0.0.1:${activeDesktopServer.port}/opds/`,
            username: "",
            allowInsecure: true,
          },
          "",
        );
        return;
      }

      // 确定性先停后起
      await stopActiveDesktopServer();

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

        const requestHandler = createLocalOpdsRequestHandler(drivers);
        const started = await platform.startLANServer(
          DESKTOP_LOCAL_OPDS_PORT,
          requestHandler,
          "127.0.0.1",
        );

        if (myGen !== desktopGeneration) {
          await platform.stopLANServer?.(started.server);
          return;
        }

        activeDesktopServer = started;
        builtDesktopRev = rev;

        await useOpdsSourcesStore.getState().hydrate();
        await useOpdsSourcesStore.getState().saveSource(
          {
            id: DESKTOP_LOCAL_OPDS_SOURCE_ID,
            name: t("library.opdsLocalServerSourceName", "本机书源 (Z-Library / LibGen)"),
            url: `http://127.0.0.1:${started.port}/opds/`,
            username: "",
            allowInsecure: true,
          },
          "",
        );

        console.log(`[DesktopLocalOpds] Server started at http://127.0.0.1:${started.port}`);
      } catch (err) {
        console.error("[DesktopLocalOpds] Failed to start server:", err);
      }
    });
  }, [shouldRun, zlConfigRev, t]);

  // 组件卸载时停服
  useEffect(() => {
    return () => {
      void stopActiveDesktopServer();
    };
  }, []);
}
