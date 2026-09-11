/**
 * DeveloperSettings — 桌面端开发者选项面板
 * 包含：Tauri 原生调试、本机书源服务端(Z-Library / LibGen 本地 OPDS 网关)及连接诊断
 */
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Wrench,
  Terminal,
  Globe,
  Radio,
  CheckCircle2,
  XCircle,
  Loader2,
  Eye,
  EyeOff,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useDeveloperStore } from "@/stores/developer-store";
import { useAppStore } from "@/stores/app-store";
import { useDriverConfigStore } from "@readany/core/sources/driver/driver-config-store";
import { ZlibDriver } from "@readany/core/sources/driver/zlib";

export function DeveloperSettings() {
  const { t } = useTranslation();
  const setDeveloperMode = useDeveloperStore((s) => s.setDeveloperMode);
  const localOpdsServer = useDeveloperStore((s) => s.localOpdsServer);
  const setLocalOpdsServer = useDeveloperStore((s) => s.setLocalOpdsServer);
  const setShowSettings = useAppStore((s) => s.setShowSettings);

  const zlConfig = useDriverConfigStore((s) => s.zlib);
  const [zlUsername, setZlUsername] = useState(zlConfig.username || "");
  const [zlPassword, setZlPassword] = useState("");
  const [zlDomain, setZlDomain] = useState(zlConfig.domain || "");
  const [showPassword, setShowPassword] = useState(false);
  const [isTestingZl, setIsTestingZl] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    void useDriverConfigStore.getState().hydrate();
  }, []);

  useEffect(() => {
    setZlUsername(zlConfig.username || "");
    setZlDomain(zlConfig.domain || "");
  }, [zlConfig.username, zlConfig.domain]);

  const handleSaveZlib = async (enabled?: boolean) => {
    try {
      await useDriverConfigStore.getState().saveZlib(
        {
          enabled: enabled !== undefined ? enabled : zlConfig.enabled,
          domain: zlDomain.trim(),
          username: zlUsername.trim(),
          authId: zlConfig.authId,
        },
        {
          password: zlPassword.trim() || undefined,
        },
      );
      if (zlPassword) setZlPassword("");
      toast.success(t("common.saveSuccess", "Z-Library 配置已保存"));
    } catch (err) {
      toast.error(t("common.failed", "保存失败: ") + String(err));
    }
  };

  const handleTestConnection = async () => {
    setIsTestingZl(true);
    setTestResult(null);
    try {
      const password = zlPassword.trim() || (await useDriverConfigStore.getState().getZlibPassword());
      const userKey = await useDriverConfigStore.getState().getZlibUserKey();
      const driver = new ZlibDriver({
        domain: zlDomain.trim() || undefined,
        username: zlUsername.trim() || "",
        password: password || "",
        ...(zlConfig.authId && userKey
          ? { auth: { id: zlConfig.authId, key: userKey } }
          : {}),
      });

      const res = await driver.testConnection();
      setTestResult({
        ok: true,
        message: `连通成功！基准镜像: ${res.base}，已获取到热门书目 ${res.books} 本`,
      });
      toast.success(t("settings.zlConnectSuccess", "Z-Library 连接成功！"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestResult({
        ok: false,
        message: `连接失败: ${msg}`,
      });
      toast.error(t("settings.zlConnectFailed", "连接失败: ") + msg);
    } finally {
      setIsTestingZl(false);
    }
  };

  const handleOpenInspector = async () => {
    try {
      // 尝试调用 Tauri 原生 DevTools
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_devtools");
    } catch {
      toast.info(t("settings.devtoolsHint", "可通过快捷键 F12 或 Ctrl+Shift+I 打开控制台"));
    }
  };

  return (
    <div className="space-y-6 p-6 max-w-2xl">
      {/* 头部提示 */}
      <div className="flex items-center justify-between border-b pb-4">
        <div>
          <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
            <Wrench className="size-5 text-amber-500" />
            {t("settings.developerOptions", "开发者选项")}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("settings.developerDesc", "包含本机书源实验性网关、连接诊断及调试工具。")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setDeveloperMode(false);
            setLocalOpdsServer(false);
            toast.info(t("settings.devModeDisabled", "已关闭并退出开发者模式"));
            setShowSettings(true, "about");
          }}
          className="text-xs text-muted-foreground hover:text-destructive"
        >
          {t("settings.disableDevMode", "退出开发者模式")}
        </Button>
      </div>

      {/* 1. 本机书源服务端 */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Radio className="size-4 text-primary" />
              <span className="text-sm font-semibold text-foreground">
                {t("settings.localOpdsServerTitle", "本机书源服务端")}
              </span>
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                127.0.0.1:19090
              </span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t(
                "settings.localOpdsServerDesc",
                "在 PC 本机启动内置 OPDS 网关，自动将 Z-Library 等上游聚合为一条「本机书源」并注册到书架。仅限自用。",
              )}
            </p>
          </div>
          <Switch
            checked={localOpdsServer}
            onCheckedChange={(v) => {
              setLocalOpdsServer(v);
              if (v) {
                toast.success(t("settings.localOpdsStarted", "本机书源服务端已就绪"));
              } else {
                toast.info(t("settings.localOpdsStopped", "本机书源服务端已关闭"));
              }
            }}
          />
        </div>

        {/* Z-Library 账号与镜像配置 */}
        <div className="border-t pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Globe className="size-4 text-muted-foreground" />
              <span className="text-xs font-semibold text-foreground">
                {t("settings.zlibrarySourceTitle", "Z-Library 上游配置")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {zlConfig.enabled ? t("common.enabled", "已启用") : t("common.disabled", "已停用")}
              </span>
              <Switch
                checked={zlConfig.enabled}
                onCheckedChange={(v) => void handleSaveZlib(v)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                {t("settings.zlEmailLabel", "账号邮箱 (登录)")}
              </label>
              <Input
                type="email"
                placeholder="name@example.com"
                value={zlUsername}
                onChange={(e) => setZlUsername(e.target.value)}
                className="h-8 text-xs"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                {t("settings.zlPasswordLabel", "账号密码")}
              </label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder={zlConfig.hasPassword ? "已保存密码 (留空不修改)" : "输入密码"}
                  value={zlPassword}
                  onChange={(e) => setZlPassword(e.target.value)}
                  className="h-8 text-xs pr-8"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {t("settings.zlDomainLabel", "镜像域名 (可选)")}
            </label>
            <Input
              type="text"
              placeholder="留空自动测速并发探测最优镜像 (如 z-library.sk)"
              value={zlDomain}
              onChange={(e) => setZlDomain(e.target.value)}
              className="h-8 text-xs font-mono"
            />
            <p className="text-[10px] text-muted-foreground">
              {t("settings.zlDomainHint", "推荐留空，程序冷启动时会自动探测最快活跃节点并记住。")}
            </p>
          </div>

          {/* 诊断结果提示卡片 */}
          {testResult && (
            <div
              className={`flex items-start gap-2 rounded-lg p-2.5 text-xs ${
                testResult.ok
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                  : "bg-destructive/10 text-destructive border border-destructive/20"
              }`}
            >
              {testResult.ok ? (
                <CheckCircle2 className="size-4 shrink-0 mt-0.5" />
              ) : (
                <XCircle className="size-4 shrink-0 mt-0.5" />
              )}
              <span className="flex-1 leading-relaxed">{testResult.message}</span>
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleTestConnection}
              disabled={isTestingZl}
              className="h-8 gap-1.5 text-xs"
            >
              {isTestingZl ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {t("settings.testZlConnection", "测试连接 (测速+登录+拉热门)")}
            </Button>

            <Button
              type="button"
              size="sm"
              onClick={() => void handleSaveZlib()}
              className="h-8 text-xs"
            >
              {t("common.save", "保存配置")}
            </Button>
          </div>
        </div>
      </div>

      {/* 2. 原生调试工具 */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Terminal className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">
            {t("settings.devtoolsTitle", "界面调试与检查器")}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.devtoolsDesc", "打开 Webview 原生开发者工具（DevTools），可审查 DOM、查看网络请求日志与脚本报错。")}
        </p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={handleOpenInspector}
          className="h-8 gap-1.5 text-xs"
        >
          <ExternalLink className="size-3.5" />
          {t("settings.openDevtools", "打开检查器 (F12)")}
        </Button>
      </div>
    </div>
  );
}
