/**
 * 本机书源服务端(实验性,开发者模式)生命周期 hook(2026-09-06;2026-09-11 重写为串行确定性生命周期):
 * devFlags.localOpdsServer 开启 → 127.0.0.1 起本地 OPDS 服务(内置上游 driver)
 * → 自动注册一条「本机书源」到书源列表(URL 恒等于实际绑定端口);关闭/卸载 → 停服并摘除书源。
 *
 * 2026-09-11 修复(目录 502 根因):此前 effect 依赖 zlConfigRev,而 start() 内部 hydrate() 会改写
 * 该 store → 自触发重建;两次运行并发(start 无串行 / 旧实例未停 / 提前 return 泄漏僵尸)→
 * 僵尸服务器占 19090 + 书源注册在旧端口 → 客户端请求打到残留实例 → 502。
 * 现在三重保障:①模块级串行链(重启=先停后起,不并发)②代号(generation)防竞态,
 * 过期运行起服后立即归还端口 ③书源 URL 永远写实际绑定端口。
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

// ---------------------------------------------------------------------------
// 模块级生命周期状态(跨 effect 运行共享,保证同一时刻至多一个服务器)
// ---------------------------------------------------------------------------
let activeServer: { port: number; server: unknown } | null = null;
/** 当前运行服务器所依据的配置版本(与 currentRev() 同构);未变则重跑不必重启 */
let builtRev: string | null = null;
/** 串行链:所有启停/注册任务排队执行,杜绝并发交错 */
let lifecycle: Promise<void> = Promise.resolve();
/** 代号:每次 effect 运行 +1;过期任务在任何副作用前自检退出 */
let generation = 0;

/** 驱动配置版本串(与 hook 依赖同构;在 hydrate 之后读取才是有效值) */
function currentRev(): string {
  const z = useDriverConfigStore.getState().zlib;
  return `${z.enabled}|${z.domain}|${z.authId}|${z.username}|${z.hasPassword}`;
}

function enqueue(task: () => Promise<void>): void {
  lifecycle = lifecycle.then(task, task).catch((e) => {
    console.warn("[LocalOpds] lifecycle task failed:", e);
  });
}

async function stopActiveServer(reason: string): Promise<void> {
  if (!activeServer) return;
  const s = activeServer;
  activeServer = null;
  builtRev = null;
  try {
    await getPlatformService().stopLANServer?.(s.server);
  } catch {
    // 停服失败不阻塞流程;端口随进程回收
  }
  console.log(`[LocalOpds] server stopped on 127.0.0.1:${s.port} (${reason})`);
}

async function registerSource(port: number, t: (key: string, defaultValue: string) => string): Promise<void> {
  await useOpdsSourcesStore.getState().hydrate();
  await useOpdsSourcesStore.getState().saveSource(
    {
      id: LOCAL_OPDS_SOURCE_ID,
      name: t("library.opdsLocalServerSourceName", "本机书源服务"),
      url: `http://127.0.0.1:${port}/opds/`,
      username: "",
      allowInsecure: true,
    },
    "",
  );
}

export function useLocalOpdsServer() {
  const enabled = useSettingsStore((s) => s.devFlags.localOpdsServer);
  // 驱动配置变化(专属链接/域名/账号/密码)时重建服务;实际是否重启由任务内 rev 比对裁决
  const zlConfig = useDriverConfigStore((s) => s.zlib);
  const zlConfigRev = `${zlConfig.enabled}|${zlConfig.domain}|${zlConfig.authId}|${zlConfig.username}|${zlConfig.hasPassword}`;
  const { t } = useTranslation();

  useEffect(() => {
    const myGen = ++generation;

    enqueue(async () => {
      if (myGen !== generation) return; // 已被更新的运行取代(由它负责启停)

      if (!enabled) {
        await stopActiveServer("disabled");
        await useOpdsSourcesStore
          .getState()
          .removeSource(LOCAL_OPDS_SOURCE_ID)
          .catch(() => {});
        return;
      }

      const platform = getPlatformService();
      if (!platform.startLANServer) {
        console.warn("[LocalOpds] startLANServer is not available on this platform");
        return;
      }

      // hydrate 会改写 driver-config store(进而触发本 effect 重跑);
      // 读 rev 必须在 hydrate 之后,这样"hydrate 触发的重跑"能命中 rev 未变 → 不重启
      await useDriverConfigStore.getState().hydrate();
      if (myGen !== generation) return;
      const rev = currentRev();

      if (activeServer && builtRev === rev) {
        await registerSource(activeServer.port, t); // 只校正书源指向,不重启
        return;
      }

      // 先停旧(确定性 stop-before-start:消灭端口占用与僵尸实例)
      await stopActiveServer("restarting");

      // 组装 drivers(已启用即挂载 Z-Library;域名可空,驱动内自动发现镜像)
      const drivers: LocalOpdsDriver[] = [new LibgenDriver()];
      const zlConfig = useDriverConfigStore.getState().zlib;
      if (zlConfig.enabled) {
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

      let bound: { port: number; server: unknown } | null = null;
      for (let port = LOCAL_OPDS_PORT_START; port <= LOCAL_OPDS_PORT_END; port++) {
        try {
          bound = await platform.startLANServer(port, handler, "127.0.0.1");
          console.log(`[LocalOpds] server started on 127.0.0.1:${bound.port}`);
          break;
        } catch {
          console.warn(`[LocalOpds] port ${port} unavailable, trying next…`);
        }
      }
      if (!bound) {
        console.warn("[LocalOpds] no free port in range; local source unavailable");
        return;
      }
      if (myGen !== generation) {
        // 竞态兜底:起服期间出现更新运行 → 立即归还端口(防僵尸)
        await platform.stopLANServer?.(bound.server).catch(() => {});
        console.log(`[LocalOpds] released stale server on 127.0.0.1:${bound.port}`);
        return;
      }
      activeServer = bound;
      builtRev = rev;

      await registerSource(bound.port, t);
    });

    return () => {
      enqueue(async () => {
        if (myGen !== generation) return; // 已被后续运行接管(它负责停旧起新)
        await stopActiveServer("unmount");
        await useOpdsSourcesStore
          .getState()
          .removeSource(LOCAL_OPDS_SOURCE_ID)
          .catch(() => {});
      });
    };
  }, [enabled, zlConfigRev, t]);
}
