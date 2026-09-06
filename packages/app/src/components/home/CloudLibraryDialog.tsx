/**
 * 桌面端云书库对话框 (CloudLibraryDialog)
 * 允许用户浏览云端书目、查看跨端阅读进度、按需下载导入到本地，或删除云端副本。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Cloud,
  CloudDownload,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSyncStore } from "@/stores/sync-store";
import { useLibraryStore } from "@/stores/library-store";
import { useProgressStore } from "@readany/core/stores/progress-store";
import { getBookProgressPercent } from "@readany/core/utils";
import type { CloudBookEntry } from "@readany/core/sync";

interface CloudLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function CloudLibraryDialog({ open, onOpenChange }: CloudLibraryDialogProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<CloudBookEntry[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [busyHash, setBusyHash] = useState<string | null>(null);
  const isSyncConfigured = useSyncStore((s) => s.isConfigured);
  const progressEntries = useProgressStore((s) => s.entries);
  const importBooks = useLibraryStore((s) => s.importBooks);
  const loadBooks = useLibraryStore((s) => s.loadBooks);

  const refresh = useCallback(async () => {
    if (!open) return;
    setIsLoading(true);
    try {
      // 1. 列表先行，秒出界面
      const result = await useSyncStore.getState().listCloudBooks();
      if ("error" in result) {
        toast.error(t("sync.cloudLibraryFetchFailed", "获取云书库失败: ") + result.error);
        setEntries(null);
      } else {
        setEntries(result);
      }

      // 2. 后台探测同步进度与状态，完成后再次更新列表
      void useSyncStore
        .getState()
        .probeAndSyncNow()
        .catch((err) => {
          console.warn("[CloudLibrary] Background sync probe failed:", err);
        })
        .then(async () => {
          const updated = await useSyncStore.getState().listCloudBooks();
          if (!("error" in updated)) {
            setEntries(updated);
          }
        });
    } catch (e) {
      toast.error(t("sync.cloudLibraryFetchFailed", "获取云书库失败: ") + String(e));
    } finally {
      setIsLoading(false);
    }
  }, [open, t]);

  useEffect(() => {
    if (open) {
      void refresh();
    }
  }, [open, refresh]);

  const handleDownload = async (entry: CloudBookEntry) => {
    setBusyHash(entry.fileHash);
    try {
      const result = await useSyncStore.getState().downloadCloudBook(entry.fileHash);
      if ("error" in result || !result.ok || !result.localPath) {
        toast.error(
          t("sync.downloadFailed", "下载失败") +
            (": " + ("error" in result ? result.error : result.error ?? "未知错误")),
        );
        return;
      }

      const importResult = await importBooks([result.localPath]);
      if (importResult.imported.length > 0) {
        toast.success(t("sync.bookImported", "《{{title}}》已成功加入书库", { title: entry.title }));
      } else if (importResult.skippedDuplicates.length > 0) {
        toast.info(t("sync.bookAlreadyExists", "《{{title}}》本地已存在", { title: entry.title }));
      } else {
        toast.error(t("sync.importFailed", "导入《{{title}}》失败", { title: entry.title }));
      }
      await loadBooks();
      await refresh();
    } catch (e) {
      toast.error(t("sync.downloadFailed", "下载失败: ") + String(e));
    } finally {
      setBusyHash(null);
    }
  };

  const handleDelete = async (entry: CloudBookEntry) => {
    if (
      !window.confirm(
        t(
          "sync.confirmDeleteCloudBook",
          "确定要删除云端的《{{title}}》吗？本地文件不受影响。",
          { title: entry.title },
        ),
      )
    ) {
      return;
    }

    setBusyHash(entry.fileHash);
    try {
      const result = await useSyncStore.getState().deleteCloudBook(entry.fileHash);
      if (result && "error" in result) {
        toast.error(t("sync.deleteCloudBookFailed", "删除云端书籍失败: ") + result.error);
      } else {
        toast.success(t("sync.deleteCloudBookSuccess", "已从云端删除"));
      }
      await refresh();
    } catch (e) {
      toast.error(t("sync.deleteCloudBookFailed", "删除失败: ") + String(e));
    } finally {
      setBusyHash(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader className="flex flex-row items-center justify-between pb-3 border-b">
          <div>
            <DialogTitle className="text-base font-semibold text-foreground">
              {t("sync.cloudLibraryTitle", "云端书库")}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground mt-0.5">
              {t("sync.cloudLibraryDesc", "管理云端存储的书籍文件与跨端阅读进度")}
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={refresh}
            disabled={isLoading}
            className="h-8 gap-1 text-xs text-muted-foreground hover:text-foreground mr-6"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
            {t("common.refresh", "刷新")}
          </Button>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto py-2 min-h-[260px]">
          {!isSyncConfigured ? (
            <div className="flex flex-col items-center justify-center h-48 text-center px-4 gap-2">
              <Cloud className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                {t("sync.notConfigured", "尚未配置同步后端，请在设置中开启 WebDAV 或云同步。")}
              </p>
            </div>
          ) : isLoading && !entries ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <span className="text-xs">{t("sync.loadingCloudLibrary", "正在同步云端书库…")}</span>
            </div>
          ) : !entries || entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center px-4 gap-1.5">
              <Cloud className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm font-medium text-foreground">
                {t("sync.cloudLibraryEmpty", "云书库空")}
              </p>
              <p className="text-xs text-muted-foreground max-w-xs">
                {t(
                  "sync.cloudLibraryEmptyHint",
                  "在本地书库卡片菜单中选择「上传至云端」即可添加到云书库",
                )}
              </p>
            </div>
          ) : (
            <div className="flex flex-col">
              <div className="text-xs text-muted-foreground px-2 py-1 mb-1 font-medium">
                {t("sync.cloudLibraryCount", "云端书库 · {{count}} 本", { count: entries.length })}
              </div>
              <div className="divide-y divide-border/50">
                {entries.map((entry) => {
                  const normHash = (entry.fileHash ?? "").toLowerCase();
                  const progressVal = normHash ? progressEntries[normHash]?.percent ?? 0 : 0;
                  const progressPct = getBookProgressPercent(progressVal);
                  const isBusy = busyHash === entry.fileHash;

                  return (
                    <div
                      key={entry.fileHash}
                      className="flex items-center justify-between py-2.5 px-2 hover:bg-muted/40 rounded-lg transition-colors gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-sm text-foreground truncate">
                          {entry.title}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {formatBytes(entry.size)}
                          {entry.hasRemoteCover ? " · 封面" : ""}
                          {progressPct > 0 ? ` · 已读 ${progressPct}%` : ""}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {entry.localBookId ? (
                          <span className="text-xs text-primary border border-primary/50 rounded-md px-2 py-0.5 font-medium">
                            {t("sync.imported", "已导入")}
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => handleDownload(entry)}
                            className="p-1.5 rounded-md text-primary hover:bg-primary/10 transition-colors disabled:opacity-40"
                            title={t("sync.downloadImport", "下载导入")}
                          >
                            {isBusy ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <CloudDownload className="h-4 w-4" />
                            )}
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleDelete(entry)}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40"
                          title={t("common.delete", "删除云端文件")}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
