/**
 * 桌面端云书库对话框 (CloudLibraryDialog)
 * 允许用户浏览云端书目、查看跨端阅读进度、按需下载导入到本地，或删除云端副本。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Cloud,
  Loader2,
  RefreshCw,
  Trash2,
  Check,
  HardDriveDownload,
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
        <DialogHeader className="flex flex-row items-center justify-between pb-2 border-b">
          <div>
            <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
              <Cloud className="h-5 w-5 text-amber-500" />
              {t("sync.cloudLibraryTitle", "云端书库")}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground mt-0.5">
              {t("sync.cloudLibraryDesc", "管理云端存储的书籍文件与跨端阅读进度")}
            </DialogDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={isLoading}
            className="h-8 gap-1.5 text-xs mr-6"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
            {t("common.refresh", "刷新")}
          </Button>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto py-2 min-h-[260px]">
          {!isSyncConfigured ? (
            <div className="flex flex-col items-center justify-center h-48 text-center px-4 gap-2">
              <Cloud className="h-10 w-10 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                {t("sync.notConfigured", "尚未配置同步后端，请在设置中开启 WebDAV 或云同步。")}
              </p>
            </div>
          ) : isLoading && !entries ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <span className="text-xs">{t("sync.loadingCloudLibrary", "正在读取云端书库…")}</span>
            </div>
          ) : !entries || entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center px-4 gap-2">
              <Cloud className="h-10 w-10 text-amber-500/50" />
              <p className="text-sm font-medium text-foreground">
                {t("sync.cloudLibraryEmpty", "云端书库暂无书籍")}
              </p>
              <p className="text-xs text-muted-foreground max-w-sm">
                {t(
                  "sync.cloudLibraryEmptyHint",
                  "在本地书架右键书籍卡片，点击「上传至云端 (绑定同步)」，即可将书籍与进度安全备份至云端并在各端流转。",
                )}
              </p>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-border/60">
              {entries.map((entry) => {
                const normHash = (entry.fileHash ?? "").toLowerCase();
                const progressVal = normHash ? progressEntries[normHash]?.percent ?? 0 : 0;
                const progressPct = getBookProgressPercent(progressVal);
                const isBusy = busyHash === entry.fileHash;

                return (
                  <div
                    key={entry.fileHash}
                    className="flex items-center justify-between py-3 px-2 hover:bg-muted/40 rounded-lg transition-colors gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm text-foreground truncate">
                          {entry.title}
                        </span>
                        {entry.localBookId && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 shrink-0">
                            <Check className="h-3 w-3" />
                            {t("sync.imported", "已在书架")}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                        <span>{formatBytes(entry.size)}</span>
                        {entry.hasRemoteCover && <span>• {t("sync.hasCover", "含封面")}</span>}
                        {progressPct > 0 && (
                          <span className="text-amber-600 font-medium">
                            • {t("sync.readProgress", "跨端进度: ")}{progressPct}%
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {!entry.localBookId && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isBusy}
                          onClick={() => handleDownload(entry)}
                          className="h-8 gap-1 text-xs"
                        >
                          {isBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <HardDriveDownload className="h-3.5 w-3.5 text-primary" />
                          )}
                          {t("sync.downloadImport", "下载导入")}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={isBusy}
                        onClick={() => handleDelete(entry)}
                        className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title={t("common.delete", "删除云端副本")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
