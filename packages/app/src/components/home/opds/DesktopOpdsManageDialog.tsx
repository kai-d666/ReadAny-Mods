import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DesktopOpdsBrowserDialog } from "./DesktopOpdsBrowserDialog";
import { DesktopOpdsSourceEditDialog } from "./DesktopOpdsSourceEditDialog";
import { type OpdsSource } from "@readany/core/sources/opds";
import { useOpdsSourcesStore } from "@readany/core/sources/opds-source-store";
import {
  ChevronRight,
  Edit2,
  Globe,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface DesktopOpdsManageDialogProps {
  open: boolean;
  onClose: () => void;
}

export function DesktopOpdsManageDialog({
  open,
  onClose,
}: DesktopOpdsManageDialogProps) {
  const { t } = useTranslation();
  const sources = useOpdsSourcesStore((state) => state.sources);
  const loaded = useOpdsSourcesStore((state) => state.loaded);

  const [editSourceId, setEditSourceId] = useState<string | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [activeBrowserSource, setActiveBrowserSource] = useState<OpdsSource | null>(null);
  const [sourceToDelete, setSourceToDelete] = useState<OpdsSource | null>(null);

  useEffect(() => {
    if (open) {
      void useOpdsSourcesStore.getState().hydrate();
    }
  }, [open]);

  const handleOpenAdd = useCallback(() => {
    setEditSourceId(null);
    setEditDialogOpen(true);
  }, []);

  const handleOpenEdit = useCallback((id: string) => {
    setEditSourceId(id);
    setEditDialogOpen(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!sourceToDelete) return;
    try {
      await useOpdsSourcesStore.getState().removeSource(sourceToDelete.id);
    } finally {
      setSourceToDelete(null);
    }
  }, [sourceToDelete]);

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="flex max-h-[85vh] w-[min(90vw,680px)] flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b px-6 pt-6 pb-4 pr-16">
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle>{t("library.opdsManageTitle", "书源管理")}</DialogTitle>
                <DialogDescription className="mt-1">
                  {t("library.opdsSourcesTitle", "OPDS 书源")}
                </DialogDescription>
              </div>
              <Button size="sm" onClick={handleOpenAdd} className="gap-1.5">
                <Plus className="size-4" />
                <span>{t("library.opdsAddSource", "添加书源")}</span>
              </Button>
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {!loaded ? null : sources.length === 0 ? (
              <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
                <Globe className="size-8 text-muted-foreground/50" />
                <p className="text-base font-semibold text-foreground">
                  {t("library.opdsListEmptyTitle", "还没有 OPDS 书源")}
                </p>
                <p className="max-w-sm text-xs leading-5 text-muted-foreground">
                  {t(
                    "library.opdsListEmptyDesc",
                    "添加一个在线目录（如古登堡计划、Calibre 书库），就能在 App 里浏览、搜索并下载书籍。",
                  )}
                </p>
                <Button size="sm" onClick={handleOpenAdd} className="mt-2 gap-1.5">
                  <Plus className="size-4" />
                  <span>{t("library.opdsAddSource", "添加书源")}</span>
                </Button>
              </div>
            ) : (
              <div className="space-y-2.5">
                {sources.map((item) => (
                  <div
                    key={item.id}
                    className="group flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 transition-colors hover:border-primary/40 hover:bg-accent/20"
                  >
                    <button
                      type="button"
                      onClick={() => setActiveBrowserSource(item)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <Globe className="size-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {item.name}
                          </span>
                          {item.username && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {item.username}
                            </span>
                          )}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">{item.url}</p>
                      </div>
                    </button>

                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 text-muted-foreground hover:text-foreground"
                        onClick={() => handleOpenEdit(item.id)}
                        title={t("library.opdsEditSource", "编辑书源")}
                      >
                        <Edit2 className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        onClick={() => setSourceToDelete(item)}
                        title={t("library.opdsDeleteSource", "删除书源")}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 text-muted-foreground hover:text-foreground"
                        onClick={() => setActiveBrowserSource(item)}
                      >
                        <ChevronRight className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除确认对话框 */}
      <Dialog
        open={!!sourceToDelete}
        onOpenChange={(next) => !next && setSourceToDelete(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("library.opdsDeleteSource", "删除书源")}</DialogTitle>
            <DialogDescription>
              {t("library.opdsDeleteConfirm", {
                defaultValue: "确定删除「{{name}}」？凭据会一并清除。",
                name: sourceToDelete?.name ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSourceToDelete(null)}>
              {t("common.cancel", "取消")}
            </Button>
            <Button variant="destructive" onClick={() => void handleConfirmDelete()}>
              {t("library.opdsDeleteSource", "删除书源")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 书源编辑/添加对话框 */}
      <DesktopOpdsSourceEditDialog
        open={editDialogOpen}
        sourceId={editSourceId}
        onClose={() => setEditDialogOpen(false)}
      />

      {/* 书源目录浏览对话框 */}
      <DesktopOpdsBrowserDialog
        source={activeBrowserSource}
        onClose={() => setActiveBrowserSource(null)}
      />
    </>
  );
}
