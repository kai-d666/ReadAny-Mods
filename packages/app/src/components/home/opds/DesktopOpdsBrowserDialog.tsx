import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useLibraryStore } from "@/stores/library-store";
import {
  buildOpenSearchUrl,
  type OpdsAcquisition,
  type OpdsFeed,
  type OpdsPublication,
  type OpdsSource,
} from "@readany/core/sources/opds";
import { OpdsClient } from "@readany/core/sources/opds-client";
import { useOpdsSourcesStore } from "@readany/core/sources/opds-source-store";
import { join, tempDir } from "@tauri-apps/api/path";
import { mkdir, remove, writeFile } from "@tauri-apps/plugin-fs";
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  Download,
  FolderOpen,
  Globe,
  Loader2,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

interface DesktopOpdsBrowserDialogProps {
  source: OpdsSource | null;
  onClose: () => void;
}

type ImportState =
  | { phase: "idle" }
  | { phase: "downloading"; name: string; percent: number }
  | { phase: "importing"; name: string };

type NavPathEntry = { title: string; href: string };

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\[\]{}#%&]/g, "_").trim() || `book-${Date.now()}`;
}

function formatBytes(size?: number): string {
  if (!size || !Number.isFinite(size) || size <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 100 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function DesktopOpdsBrowserDialog({
  source,
  onClose,
}: DesktopOpdsBrowserDialogProps) {
  const { t } = useTranslation();
  const importBooks = useLibraryStore((state) => state.importBooks);

  const [client, setClient] = useState<OpdsClient | null>(null);
  const [navPath, setNavPath] = useState<NavPathEntry[]>([]);
  const [feed, setFeed] = useState<OpdsFeed | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [importState, setImportState] = useState<ImportState>({ phase: "idle" });

  const openSearchRef = useRef<{ href?: string; template: string } | null>(null);

  const loadFeedWith = useCallback(
    async (activeClient: OpdsClient, href: string, title: string, append: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const nextFeed = await activeClient.fetchFeed(href);
        setFeed((prev) =>
          append && prev
            ? { ...nextFeed, publications: [...prev.publications, ...nextFeed.publications] }
            : nextFeed,
        );
        if (!append) {
          setNavPath((cur) => {
            const top = cur[cur.length - 1];
            if (top && top.href === href) return cur;
            return [...cur, { title, href }];
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    openSearchRef.current = null;
    setSearch("");
    setNavPath([]);
    setFeed(null);
    setError(null);
    setImportState({ phase: "idle" });

    void (async () => {
      const password = await useOpdsSourcesStore.getState().getPassword(source.id);
      if (cancelled) return;
      const readyClient = new OpdsClient(source, password);
      setClient(readyClient);
      const root = { title: source.name, href: source.url };
      setNavPath([root]);
      await loadFeedWith(readyClient, root.href, root.title, false);
    })();

    return () => {
      cancelled = true;
    };
  }, [loadFeedWith, source]);

  const handleGoBack = useCallback(() => {
    if (navPath.length > 1 && client) {
      const parent = navPath[navPath.length - 2];
      setNavPath(navPath.slice(0, -1));
      if (parent) {
        void loadFeedWith(client, parent.href, parent.title, false);
      }
      return;
    }
    onClose();
  }, [client, loadFeedWith, navPath, onClose]);

  const handleNavPush = useCallback(
    (entry: { title: string; href: string }) => {
      if (!client) return;
      void loadFeedWith(client, entry.href, entry.title, false);
    },
    [client, loadFeedWith],
  );

  const handleSearchSubmit = useCallback(async () => {
    const query = search.trim();
    if (!query || !client || !feed) return;
    try {
      if (!openSearchRef.current) {
        if (feed.searchTemplate) {
          openSearchRef.current = { template: feed.searchTemplate };
        } else if (feed.searchHref) {
          const os = await client.fetchOpenSearch(feed.searchHref);
          openSearchRef.current = { href: feed.searchHref, template: os.template };
        }
      }
      const template = openSearchRef.current?.template;
      if (!template) return;
      const searchUrl = buildOpenSearchUrl(template, query);
      await loadFeedWith(client, searchUrl, query, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, feed, loadFeedWith, search]);

  const handleLoadNext = useCallback(() => {
    if (!client || !feed?.nextHref || loading) return;
    void loadFeedWith(client, feed.nextHref, "", true);
  }, [client, feed?.nextHref, loading, loadFeedWith]);

  const runDownload = useCallback(
    async (acq: OpdsAcquisition, pub: OpdsPublication) => {
      if (!client) return;
      const safeName = sanitizeFilename(pub.title);
      const tempRoot = await tempDir();
      const workspace = await join(tempRoot, "readany-opds-import");
      await mkdir(workspace, { recursive: true });
      const tempPath = await join(
        workspace,
        `readany-opds-${Date.now()}-${safeName}.${acq.extension}`,
      );

      try {
        setImportState({ phase: "downloading", name: pub.title, percent: 0 });
        const bytes = await client.downloadFile(acq.href, {
          onProgress: (loaded, total) => {
            const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
            setImportState({ phase: "downloading", name: pub.title, percent });
          },
        });

        // 魔数校验: 检查 epub(PK) 或 pdf(%PDF)，防止错误落地
        const ext = acq.extension.toLowerCase();
        if (ext === "epub" || ext === "pdf") {
          const isEpub = bytes[0] === 0x50 && bytes[1] === 0x4b;
          const isPdf =
            bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
          if (!isEpub && !isPdf) {
            throw new Error(
              t(
                "library.opdsDownloadVerificationFailed",
                "下载的内容不是有效的电子书（书源服务器可能繁忙），请稍后重试。",
              ),
            );
          }
        }

        await writeFile(tempPath, bytes);
        setImportState({ phase: "importing", name: pub.title });

        const result = await importBooks([tempPath]);
        if (result.imported.length > 0) {
          toast.success(
            t("library.opdsImportDone", { defaultValue: "《{{name}}》已加入书库", name: pub.title }),
          );
        } else if (result.skippedDuplicates.length > 0) {
          toast.info(t("library.opdsImportSkipped", "书库已有同内容书籍，无需重复下载"));
        } else if (result.failures.length > 0) {
          toast.error(
            t("library.opdsImportFailed", {
              defaultValue: "导入失败：{{error}}",
              error: result.failures[0]?.error ?? "unknown",
            }),
          );
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        try {
          await remove(tempPath);
        } catch {
          // best-effort cleanup
        }
        setImportState({ phase: "idle" });
      }
    },
    [client, importBooks, t],
  );

  const currentTitle =
    navPath.length > 0 ? navPath[navPath.length - 1].title : (feed?.title ?? source?.name ?? "");
  const hasSearch = !!(feed?.searchHref || feed?.searchTemplate);

  const importBusy = importState.phase !== "idle";
  const statusLabel =
    importState.phase === "downloading"
      ? t("library.opdsDownloading", {
          name: importState.name,
          percent: importState.percent,
        })
      : importState.phase === "importing"
        ? t("library.opdsImporting", { name: importState.name })
        : null;

  return (
    <Dialog open={!!source} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex h-[84vh] max-h-[880px] w-[min(94vw,980px)] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-6 pt-6 pb-4 pr-16">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0 flex-1 space-y-1">
              <DialogTitle className="truncate">{currentTitle || t("library.opdsCatalogTitle", "在线目录")}</DialogTitle>
              <DialogDescription className="truncate">
                {source?.url}
              </DialogDescription>
            </div>

            {navPath.length > 1 && (
              <div className="inline-flex max-w-[360px] shrink-0 items-center rounded-full border bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
                <span className="truncate">
                  {navPath.map((entry) => entry.title).join(" › ")}
                </span>
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleGoBack}
              disabled={loading || importBusy}
            >
              <ArrowLeft className="size-4" />
              {t("common.back", "返回")}
            </Button>

            {hasSearch ? (
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSearchSubmit();
                  }}
                  className="pl-9"
                  placeholder={t("library.opdsSearchPlaceholder", "搜索书名或作者...")}
                />
              </div>
            ) : (
              <div className="flex-1" />
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading && !feed ? (
            <div className="flex h-full min-h-72 flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="size-6 animate-spin" />
              <p className="text-sm">{t("library.opdsLoadingFeed", "正在读取目录...")}</p>
            </div>
          ) : error ? (
            <div className="flex h-full min-h-72 flex-col items-center justify-center gap-4 text-center">
              <div>
                <p className="text-lg font-semibold text-foreground">
                  {t("library.opdsLoadFailed", "读取目录失败")}
                </p>
                <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{error}</p>
              </div>
              <Button
                onClick={() => {
                  const last = navPath[navPath.length - 1];
                  if (client && last) void loadFeedWith(client, last.href, last.title, false);
                }}
              >
                {t("common.retry", "重试")}
              </Button>
            </div>
          ) : !feed || (feed.navigation.length === 0 && feed.publications.length === 0) ? (
            <div className="flex h-full min-h-72 flex-col items-center justify-center gap-3 text-center">
              <Globe className="size-8 text-muted-foreground/50" />
              <p className="text-lg font-semibold text-foreground">
                {search ? t("library.opdsNoResults", "没有搜到结果") : t("library.opdsListEmptyTitle", "目录为空")}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* 子目录 / 导航条目 */}
              {feed.navigation.length > 0 && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
                  {feed.navigation.map((nav, index) => (
                    <button
                      key={`nav-${index}-${nav.href}`}
                      type="button"
                      onClick={() => handleNavPush(nav)}
                      className="flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/40"
                    >
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <FolderOpen className="size-4" />
                      </div>
                      <span className="truncate text-sm font-medium text-foreground">
                        {nav.title}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {/* 出版物书籍列表 */}
              {feed.publications.length > 0 && (
                <div className="space-y-2.5">
                  {feed.publications.map((pub, index) => {
                    const isDownloadingThis = importBusy && importState.name === pub.title;
                    const supportedAcqs = pub.acquisitions
                      .filter((a) => a.priority >= 0)
                      .sort((a, b) => a.priority - b.priority);

                    return (
                      <div
                        key={`pub-${index}-${pub.id ?? pub.title}`}
                        className="flex items-start gap-4 rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/40"
                      >
                        {pub.thumbnailUrl || pub.coverUrl ? (
                          <img
                            src={pub.thumbnailUrl || pub.coverUrl}
                            alt={pub.title}
                            className="size-16 shrink-0 rounded-lg object-cover shadow-sm"
                            onError={(e) => {
                              (e.target as HTMLElement).style.display = "none";
                            }}
                          />
                        ) : (
                          <div className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                            <BookOpen className="size-6" />
                          </div>
                        )}

                        <div className="min-w-0 flex-1 space-y-1">
                          <h4 className="line-clamp-2 text-sm font-medium text-foreground">
                            {pub.title}
                          </h4>
                          <p className="text-xs text-muted-foreground">
                            {[
                              pub.authors.join(", "),
                              pub.issued,
                              pub.language,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                          {pub.summary && (
                            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground/80">
                              {pub.summary}
                            </p>
                          )}
                        </div>

                        <div className="shrink-0 pt-0.5">
                          {supportedAcqs.length === 0 ? (
                            <span className="text-xs text-muted-foreground">
                              {t("library.opdsNoAcquisition", "暂无可下载格式")}
                            </span>
                          ) : supportedAcqs.length === 1 ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void runDownload(supportedAcqs[0], pub)}
                              disabled={importBusy}
                              className="gap-1.5"
                            >
                              {isDownloadingThis ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Download className="size-3.5" />
                              )}
                              <span>
                                {supportedAcqs[0].extension.toUpperCase()}
                                {supportedAcqs[0].size ? ` (${formatBytes(supportedAcqs[0].size)})` : ""}
                              </span>
                            </Button>
                          ) : (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={importBusy}
                                  className="gap-1.5"
                                >
                                  {isDownloadingThis ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                  ) : (
                                    <Download className="size-3.5" />
                                  )}
                                  <span>{t("library.opdsDownload", "下载")}</span>
                                  <ChevronDown className="size-3 text-muted-foreground" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-48">
                                {supportedAcqs.map((acq, acqIdx) => (
                                  <DropdownMenuItem
                                    key={`acq-${acqIdx}-${acq.extension}`}
                                    onClick={() => void runDownload(acq, pub)}
                                    className="flex items-center justify-between text-xs"
                                  >
                                    <span className="font-medium">
                                      {acq.extension.toUpperCase()}
                                      {acqIdx === 0 && ` (${t("library.opdsRecommended", "推荐")})`}
                                    </span>
                                    <span className="text-muted-foreground">
                                      {formatBytes(acq.size)}
                                    </span>
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {feed.nextHref && (
                <div className="flex justify-center pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleLoadNext}
                    disabled={loading}
                    className="gap-2"
                  >
                    {loading && <Loader2 className="size-3.5 animate-spin" />}
                    {t("library.opdsNextPage", "加载更多")}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {importBusy && (
          <div className="border-t bg-muted/20 px-6 py-3">
            <div className="flex items-center gap-3 text-sm text-foreground">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span>{statusLabel}</span>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
