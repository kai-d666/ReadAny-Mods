import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { OpdsClient } from "@readany/core/sources/opds-client";
import { useOpdsSourcesStore } from "@readany/core/sources/opds-source-store";
import { generateId } from "@readany/core/utils/generate-id";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface DesktopOpdsSourceEditDialogProps {
  open: boolean;
  sourceId: string | null;
  onClose: () => void;
}

export function DesktopOpdsSourceEditDialog({
  open,
  sourceId,
  onClose,
}: DesktopOpdsSourceEditDialogProps) {
  const { t } = useTranslation();

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [allowInsecure, setAllowInsecure] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);
  const [testError, setTestError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTestResult(null);
    setTestError("");
    setSaving(false);
    setTesting(false);

    if (sourceId) {
      void (async () => {
        await useOpdsSourcesStore.getState().hydrate();
        const stored = useOpdsSourcesStore.getState().getSource(sourceId);
        if (!stored) return;
        setName(stored.name);
        setUrl(stored.url);
        setUsername(stored.username ?? "");
        setAllowInsecure(stored.allowInsecure ?? false);
        setPasswordSaved(!!stored.hasPassword);
        setPassword("");
      })();
    } else {
      setName("");
      setUrl("");
      setUsername("");
      setPassword("");
      setPasswordSaved(false);
      setAllowInsecure(false);
    }
  }, [open, sourceId]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    setTestError("");
    try {
      const id = sourceId ?? "test";
      const storedPassword =
        password !== "" ? password : await useOpdsSourcesStore.getState().getPassword(id);
      const client = new OpdsClient(
        {
          id,
          name: name.trim() || "test",
          url: url.trim(),
          username: username.trim(),
          allowInsecure,
        },
        storedPassword,
      );
      const feed = await client.testConnection();
      setTestResult("success");
      if (!name.trim() && feed.title) {
        setName(feed.title);
      }
    } catch (err) {
      setTestResult("error");
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }, [allowInsecure, name, password, sourceId, url, username]);

  const handleSave = useCallback(async () => {
    if (!name.trim() || !url.trim()) return;
    setSaving(true);
    try {
      const id = sourceId ?? generateId();
      await useOpdsSourcesStore.getState().saveSource(
        {
          id,
          name: name.trim(),
          url: url.trim(),
          username: username.trim(),
          allowInsecure,
        },
        password,
      );
      onClose();
    } catch (err) {
      setTestResult("error");
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [allowInsecure, name, onClose, password, sourceId, url, username]);

  const canTest = !testing && url.trim().length > 0;
  const canSave = !saving && name.trim().length > 0 && url.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-[540px]">
        <DialogHeader>
          <DialogTitle>
            {sourceId
              ? t("library.opdsEditSource", "编辑书源")
              : t("library.opdsAddSource", "添加书源")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "library.opdsListEmptyDesc",
              "添加一个在线目录（如古登堡计划、Calibre 书库），就能在 App 里浏览、搜索并下载书籍。",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              {t("library.opdsName", "书源名称")}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("library.opdsNamePlaceholder", "古登堡计划")}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              {t("library.opdsSourceUrl", "目录地址")}
            </label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("library.opdsSourceUrlPlaceholder", "https://www.gutenberg.org/ebooks.opds/")}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                {t("library.opdsUsername", "用户名（可选）")}
              </label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t("library.opdsUsername", "用户名（可选）")}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                {t("library.opdsPassword", "密码（可选，留空则匿名）")}
              </label>
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  passwordSaved
                    ? t("library.opdsPasswordHint", "已保存密码，留空表示不修改")
                    : t("library.opdsPassword", "密码（可选，留空则匿名）")
                }
              />
            </div>
          </div>

          <label className="flex items-start gap-3 rounded-xl border border-border bg-muted/30 px-3 py-3">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={allowInsecure}
              onChange={(e) => setAllowInsecure(e.target.checked)}
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium text-foreground">
                {t("library.opdsAllowInsecure", "允许不安全连接（http 明文/自签证书）")}
              </span>
              <span className="block text-xs leading-5 text-muted-foreground">
                {t(
                  "library.importAllowInsecureHint",
                  "对自签名证书或纯 HTTP 服务有帮助，生产环境仍建议使用 HTTPS。",
                )}
              </span>
            </span>
          </label>

          {testResult === "success" && (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-4 shrink-0" />
              <span>{t("library.opdsTestSuccess", "连接成功，这是一个 OPDS 目录")}</span>
            </div>
          )}

          {testResult === "error" && (
            <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <XCircle className="mt-0.5 size-4 shrink-0" />
              <span className="break-all leading-5">{testError}</span>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleTest()}
            disabled={!canTest}
          >
            {testing ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t("library.opdsTesting", "连接中...")}
              </>
            ) : (
              t("library.opdsTestConnection", "测试连接")
            )}
          </Button>
          <div className="flex-1" />
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("common.cancel", "取消")}
          </Button>
          <Button onClick={() => void handleSave()} disabled={!canSave}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t("common.saving", "保存中...")}
              </>
            ) : (
              t("library.opdsSaveSource", "保存")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
