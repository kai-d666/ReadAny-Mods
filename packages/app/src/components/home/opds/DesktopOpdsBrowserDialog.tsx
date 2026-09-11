import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { cn } from "@readany/core/utils";
import {
  createImportDuplicateIndex,
  findLikelyDuplicateBook,
} from "@readany/core";
import {
  buildOpenSearchUrl,
  type OpdsAcquisition,
  type OpdsFacet,
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
  BookCheck,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Download,
  Folder,
  FolderOpen,
  Globe,
  Info,
  LayoutGrid,
  List,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/** 分面组显示配置: label + 内联上限 */
const FACET_GROUP_META: Record<string, { label: string; inlineLimit: number }> = {
  order: { label: "排序", inlineLimit: Number.MAX_SAFE_INTEGER },
  language: { label: "语言", inlineLimit: 8 },
  format: { label: "格式", inlineLimit: 6 },
};

/** 分面组 → URL 参数键 */
const FACET_PARAM_KEY: Record<string, "order" | "lang" | "ext"> = {
  order: "order",
  language: "lang",
  format: "ext",
};

function facetValueOf(facet: OpdsFacet, paramKey: string): string {
  try {
    return new URL(facet.href).searchParams.get(paramKey) ?? "";
  } catch {
    return "";
  }
}

type FilterSel = { order: string; lang: string; ext: string };

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

/** 拟物书封组件：带 28:41 比例、真实书脊反光 (book-spine) 与纸质渐变 fallback */
function OpdsBookCover({
  title,
  author,
  coverUrl,
  thumbnailUrl,
  className,
}: {
  title: string;
  author?: string;
  coverUrl?: string;
  thumbnailUrl?: string;
  className?: string;
}) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const src = coverUrl || thumbnailUrl;

  useEffect(() => {
    setImageLoaded(false);
    setImageError(false);
  }, [src]);

  return (
    <div
      className={cn(
        "book-cover-shadow relative flex aspect-[28/41] w-full items-end justify-center overflow-hidden rounded bg-muted/40 transition-all duration-200",
        className,
      )}
    >
      {src && !imageError ? (
        <img
          src={src}
          alt={title}
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-300",
            imageLoaded ? "opacity-100" : "opacity-0",
          )}
          loading="lazy"
          onLoad={(e) => {
            if (e.currentTarget.naturalWidth > 0) {
              setImageLoaded(true);
            } else {
              setImageError(true);
            }
          }}
          onError={() => setImageError(true)}
        />
      ) : null}

      {/* 书脊立体光影 */}
      {imageLoaded && !imageError && <div className="book-spine absolute inset-0 rounded pointer-events-none" />}

      {/* 无封面优雅 Fallback (优雅衬线排版) */}
      {(!src || imageError || !imageLoaded) && (
        <div className="absolute inset-0 flex flex-col items-center rounded bg-gradient-to-b from-stone-100 to-stone-200 p-2.5 dark:from-stone-800 dark:to-stone-900 select-none">
          <div className="flex flex-1 items-center justify-center">
            <span className="line-clamp-3 text-center font-serif text-xs font-medium leading-snug text-stone-600 dark:text-stone-300">
              {title}
            </span>
          </div>
          <div className="h-px w-6 bg-stone-300/60 dark:bg-stone-700/60" />
          {author && (
            <div className="flex h-1/4 items-center justify-center">
              <span className="line-clamp-1 text-center font-serif text-[10px] text-stone-500 dark:text-stone-400">
                {author}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 书籍详情对话框：显示高清封面、全部作者/年份/语言、完整未截断简介及所有格式下载 */
function OpdsBookDetailsModal({
  pub,
  open,
  client,
  onClose,
  onDownload,
  onSelectSimilar,
  isDownloading,
  isAlreadyInLibrary,
}: {
  pub: OpdsPublication | null;
  open: boolean;
  client: OpdsClient | null;
  onClose: () => void;
  onDownload: (acq: OpdsAcquisition) => void;
  onSelectSimilar?: (pub: OpdsPublication) => void;
  isDownloading: boolean;
  isAlreadyInLibrary: boolean;
}) {
  const { t } = useTranslation();
  const [enrichedPub, setEnrichedPub] = useState<OpdsPublication | null>(pub);
  const [isEnriching, setIsEnriching] = useState(false);

  // 相似书籍 & 评论状态
  const [similarList, setSimilarList] = useState<OpdsPublication[] | null>(null);
  const [similarBusy, setSimilarBusy] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentsList, setCommentsList] = useState<Array<{ id?: number | string; user: string; premium?: boolean; date?: string; text: string }> | null>(null);
  const [commentsBusy, setCommentsBusy] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);

  const currentPub = enrichedPub ?? pub;

  const driverEndpointUrl = useCallback((p: OpdsPublication, endpoint: string): string | null => {
    const detailHref = p.detailHref;
    if (detailHref) {
      try {
        const u = new URL(detailHref);
        u.pathname = u.pathname.replace(/\/detail(?=\?|$)/, `/${endpoint}`);
        return u.toString();
      } catch {}
    }
    const acq = p.acquisitions[0];
    if (!acq) return null;
    try {
      const u = new URL(acq.href);
      u.pathname = u.pathname.replace(/\/download(?=\?|$)/, `/${endpoint}`);
      u.searchParams.delete("extension");
      u.searchParams.delete("href");
      return u.toString();
    } catch {
      return null;
    }
  }, []);

  const handleOpenSimilar = useCallback(async () => {
    if (!currentPub || !client) return;
    const url = driverEndpointUrl(currentPub, "similar");
    if (!url) {
      toast.info(t("library.opdsNoResults", "当前书源不支持相似书籍推荐"));
      return;
    }
    setSimilarBusy(true);
    try {
      const feed = await client.fetchFeed(url);
      setSimilarList(feed.publications);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSimilarBusy(false);
    }
  }, [client, currentPub, driverEndpointUrl, t]);

  const handleOpenComments = useCallback(async () => {
    if (!currentPub) return;
    const url = driverEndpointUrl(currentPub, "comments");
    if (!url) {
      toast.info(t("library.opdsNoResults", "当前书源不支持查看书评"));
      return;
    }
    setCommentsOpen(true);
    setCommentsBusy(true);
    setCommentsError(null);
    setCommentsList(null);
    try {
      const { getPlatformService } = await import("@readany/core/services");
      const resp = await getPlatformService().fetch(url, { responseType: "text" });
      const text = await resp.text();
      const data = JSON.parse(text) as { comments?: Array<{ id?: number | string; user: string; premium?: boolean; date?: string; text: string }> };
      setCommentsList(data.comments ?? []);
    } catch (err) {
      setCommentsError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommentsBusy(false);
    }
  }, [currentPub, driverEndpointUrl, t]);

  useEffect(() => {
    setEnrichedPub(pub);
    if (!pub || pub.acquisitions.length > 0 || !pub.detailHref) {
      setIsEnriching(false);
      return;
    }

    let cancelled = false;
    setIsEnriching(true);

    void (async () => {
      try {
        const { getPlatformService } = await import("@readany/core/services");
        const resp = await getPlatformService().fetch(pub.detailHref!, { responseType: "text" });
        const text = await resp.text();
        const data = JSON.parse(text) as {
          book?: {
            extension?: string;
            description?: string;
            publisher?: string;
            pages?: number | string;
            filesize?: number;
            language?: string;
          };
        };
        if (cancelled) return;
        const b = data.book ?? {};
        const ext = typeof b.extension === "string" ? b.extension.toLowerCase() : "";
        const detailHref = pub.detailHref!;
        setEnrichedPub({
          ...pub,
          summary: pub.summary ?? (b.description || undefined),
          publisher: pub.publisher ?? (b.publisher || undefined),
          extent: pub.extent ?? (b.pages != null && b.pages !== "" ? String(b.pages) : undefined),
          language: pub.language ?? (b.language || undefined),
          acquisitions: ext
            ? [
                {
                  href: `${detailHref.replace(/\/detail(?=\?|$)/, "/download")}&extension=${encodeURIComponent(ext)}`,
                  type: "",
                  extension: ext,
                  priority: 0,
                  size: typeof b.filesize === "number" ? b.filesize : undefined,
                },
              ]
            : pub.acquisitions,
        });
      } catch (err) {
        console.warn("[DesktopOpdsBrowser] detail enrich failed:", err);
      } finally {
        if (!cancelled) setIsEnriching(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pub]);

  if (!pub || !currentPub) return null;

  const supportedAcqs = currentPub.acquisitions
    .filter((a) => a.priority >= 0)
    .sort((a, b) => a.priority - b.priority);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl overflow-hidden p-0 gap-0">
        <div className="flex flex-col sm:flex-row max-h-[85vh]">
          {/* 左侧封面区域 */}
          <div className="relative flex sm:w-56 shrink-0 flex-col items-center justify-center bg-muted/30 p-6 border-b sm:border-b-0 sm:border-r border-border">
            <div className="w-36 max-w-full drop-shadow-md">
              <OpdsBookCover
                title={currentPub.title}
                author={currentPub.authors[0]}
                coverUrl={currentPub.coverUrl}
                thumbnailUrl={currentPub.thumbnailUrl}
              />
            </div>
            {isAlreadyInLibrary && (
              <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <BookCheck className="size-3.5" />
                <span>{t("library.opdsAlreadyInLibrary", "已在书库中")}</span>
              </div>
            )}
          </div>

          {/* 右侧详情与下载 */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden p-6">
            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
              <div>
                <h3 className="text-lg font-bold text-foreground leading-snug">
                  {currentPub.title}
                </h3>
                {currentPub.authors.length > 0 && (
                  <p className="mt-1 text-sm text-primary font-medium">
                    {currentPub.authors.join("、")}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {currentPub.issued && <span>{t("library.detailsPublished")}: {currentPub.issued}</span>}
                  {currentPub.language && <span>{t("library.detailsLanguage")}: {currentPub.language}</span>}
                </div>
              </div>

              {/* 简介 / 摘要 */}
              <div className="space-y-1.5 border-t pt-3">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {t("library.detailsDescription", "简介")}
                </h4>
                <div className="rounded-xl bg-muted/30 p-3 text-xs leading-relaxed text-foreground whitespace-pre-wrap max-h-56 overflow-y-auto">
                  {currentPub.summary || t("library.detailsNoDescription", "暂无简介内容")}
                </div>
              </div>

              {/* 下载格式列表 */}
              <div className="space-y-2 border-t pt-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {t("library.opdsPickFormat", "可下载格式")}
                  </h4>
                  {isEnriching && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      <span>{t("common.loading", "加载格式中...")}</span>
                    </div>
                  )}
                </div>
                {!isEnriching && supportedAcqs.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("library.opdsNoAcquisition", "暂无可下载格式")}
                  </p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {supportedAcqs.map((acq, index) => (
                      <button
                        key={`${acq.extension}-${acq.href}`}
                        type="button"
                        onClick={() => {
                          onDownload(acq);
                          onClose();
                        }}
                        disabled={isDownloading}
                        className="flex items-center justify-between rounded-xl border border-border bg-card p-2.5 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:opacity-50"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-xs text-foreground uppercase">
                              {acq.extension}
                            </span>
                            {index === 0 && (
                              <span className="rounded bg-primary/10 px-1.5 py-0.2 text-[10px] font-medium text-primary">
                                {t("library.opdsRecommended", "推荐")}
                              </span>
                            )}
                          </div>
                          <span className="text-[11px] text-muted-foreground">
                            {formatBytes(acq.size) || "—"}
                          </span>
                        </div>
                        <Download className="size-4 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 动作区 (koplugin 同款: 更多相似书籍 + 读者评论) */}
              <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleOpenSimilar}
                  disabled={similarBusy}
                  className="gap-1.5 rounded-xl text-xs h-8"
                >
                  {similarBusy ? (
                    <Loader2 className="size-3.5 animate-spin text-primary" />
                  ) : (
                    <Sparkles className="size-3.5 text-amber-500" />
                  )}
                  <span>{t("library.opdsMoreSimilar", "更多相似书籍")}</span>
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleOpenComments}
                  className="gap-1.5 rounded-xl text-xs h-8"
                >
                  <MessageSquare className="size-3.5 text-blue-500" />
                  <span>{t("library.opdsComments", "读者评论")}</span>
                </Button>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2 border-t pt-3">
              <Button variant="outline" size="sm" onClick={onClose}>
                {t("common.close", "关闭")}
              </Button>
              {supportedAcqs.length > 0 && (
                <Button
                  size="sm"
                  disabled={isDownloading}
                  onClick={() => {
                    onDownload(supportedAcqs[0]);
                    onClose();
                  }}
                  className="gap-1.5"
                >
                  <Download className="size-3.5" />
                  <span>
                    {t("library.opdsDownloadRecommended", {
                      defaultValue: "下载推荐格式 ({{ext}})",
                      ext: supportedAcqs[0].extension.toUpperCase(),
                    })}
                  </span>
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>

      {/* 更多相似书籍弹层 */}
      <Dialog open={!!similarList} onOpenChange={(next) => !next && setSimilarList(null)}>
        <DialogContent className="max-w-lg p-5">
          <DialogHeader className="pb-3 border-b">
            <DialogTitle className="text-base font-semibold flex items-center gap-2">
              <Sparkles className="size-4 text-amber-500" />
              <span>{t("library.opdsMoreSimilar", "更多相似书籍")}</span>
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto space-y-2 py-2">
            {similarList?.length === 0 ? (
              <p className="text-center py-8 text-xs text-muted-foreground">
                {t("library.opdsNoResults", "没有搜到结果")}
              </p>
            ) : (
              similarList?.map((item) => (
                <button
                  key={`${item.id ?? item.title}`}
                  type="button"
                  onClick={() => {
                    setSimilarList(null);
                    onSelectSimilar?.(item);
                  }}
                  className="w-full flex items-center gap-3 p-2.5 rounded-xl border border-border bg-card hover:bg-accent/40 hover:border-primary/40 text-left transition-all group"
                >
                  <div className="size-10 shrink-0 overflow-hidden rounded bg-muted flex items-center justify-center">
                    {item.thumbnailUrl ? (
                      <img src={item.thumbnailUrl} alt="" className="size-full object-cover" />
                    ) : (
                      <BookOpen className="size-5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground truncate group-hover:text-primary transition-colors">
                      {item.title}
                    </p>
                    {item.authors.length > 0 && (
                      <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                        {item.authors.join(" / ")}
                      </p>
                    )}
                  </div>
                  <ChevronRight className="size-4 text-muted-foreground shrink-0 group-hover:translate-x-0.5 transition-transform" />
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 读者评论弹层 */}
      <Dialog open={commentsOpen} onOpenChange={(next) => !next && setCommentsOpen(false)}>
        <DialogContent className="max-w-lg p-5">
          <DialogHeader className="pb-3 border-b">
            <DialogTitle className="text-base font-semibold flex items-center gap-2">
              <MessageSquare className="size-4 text-blue-500" />
              <span>{t("library.opdsComments", "读者评论")}</span>
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto space-y-3 py-2">
            {commentsBusy ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-6 animate-spin text-primary" />
              </div>
            ) : commentsError ? (
              <p className="text-center py-8 text-xs text-destructive">{commentsError}</p>
            ) : (commentsList ?? []).length === 0 ? (
              <p className="text-center py-8 text-xs text-muted-foreground">
                {t("library.opdsNoComments", "暂无评论内容")}
              </p>
            ) : (
              commentsList?.map((c, idx) => (
                <div key={`${c.id ?? idx}`} className="rounded-xl border border-border p-3 bg-muted/20 space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground flex items-center gap-1">
                      {c.user}
                      {c.premium && <Star className="size-3 text-amber-500 fill-amber-500" />}
                    </span>
                    {c.date && <span className="text-[10px]">{c.date}</span>}
                  </div>
                  <p className="text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap">{c.text}</p>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

export function DesktopOpdsBrowserDialog({
  source,
  onClose,
}: DesktopOpdsBrowserDialogProps) {
  const { t } = useTranslation();
  const importBooks = useLibraryStore((state) => state.importBooks);
  const localBooks = useLibraryStore((state) => state.books);

  const duplicateIndex = useMemo(() => createImportDuplicateIndex(localBooks), [localBooks]);

  const [client, setClient] = useState<OpdsClient | null>(null);
  const [navPath, setNavPath] = useState<NavPathEntry[]>([]);
  const [feed, setFeed] = useState<OpdsFeed | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterSel, setFilterSel] = useState<FilterSel | null>(null);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [importState, setImportState] = useState<ImportState>({ phase: "idle" });
  const [selectedPublication, setSelectedPublication] = useState<OpdsPublication | null>(null);

  const openSearchRef = useRef<{ href?: string; template: string } | null>(null);

  const loadFeedWith = useCallback(
    async (
      activeClient: OpdsClient,
      href: string,
      title: string,
      append: boolean,
      navMode: "push" | "replace" | "none" = "push",
    ) => {
      setLoading(true);
      setError(null);
      try {
        const nextFeed = await activeClient.fetchFeed(href);
        setFeed((prev) =>
          append && prev
            ? { ...nextFeed, publications: [...prev.publications, ...nextFeed.publications] }
            : nextFeed,
        );
        if (!append && navMode !== "none") {
          setNavPath((cur) => {
            const top = cur[cur.length - 1];
            if (navMode === "replace" && top && top.href !== href) {
              return [...cur.slice(0, -1), { title, href }];
            }
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

  // 初始化或到达带分面的源时，同步分面默认选中状态
  useEffect(() => {
    if (feed?.facets && feed.facets.length > 0) {
      setFilterSel((cur) => {
        if (cur) return cur;
        const facets = feed.facets ?? [];
        const pick = (group: string, key: string) => {
          const active = facets.find((f) => f.group === group && f.active);
          return active ? facetValueOf(active, key) : "";
        };
        return {
          order: pick("order", "order") || "bestmatch",
          lang: pick("language", "lang"),
          ext: pick("format", "ext"),
        };
      });
    } else {
      setFilterSel(null);
    }
  }, [feed?.facets]);

  const handleFacetTap = useCallback((groupId: string, facet: OpdsFacet) => {
    const key = FACET_PARAM_KEY[groupId];
    if (!key) return;
    const value = facetValueOf(facet, key);
    setFilterSel((cur) => ({
      order: "bestmatch",
      lang: "",
      ext: "",
      ...(cur ?? {}),
      [key]: value,
    }));
  }, []);

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

  const handleJumpToNav = useCallback(
    (index: number) => {
      if (!client || index < 0 || index >= navPath.length) return;
      const target = navPath[index];
      setNavPath(navPath.slice(0, index + 1));
      void loadFeedWith(client, target.href, target.title, false);
    },
    [client, loadFeedWith, navPath],
  );

  const handleRefresh = useCallback(() => {
    const current = navPath[navPath.length - 1];
    if (!client || !current) return;
    void loadFeedWith(client, current.href, current.title, false);
  }, [client, loadFeedWith, navPath]);

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

      let finalUrl = searchUrl;
      try {
        const u = new URL(searchUrl);
        if (filterSel) {
          u.searchParams.set("order", filterSel.order);
          if (filterSel.lang) u.searchParams.set("lang", filterSel.lang);
          if (filterSel.ext) u.searchParams.set("ext", filterSel.ext);
        } else if (feed?.href) {
          const cur = new URL(feed.href);
          for (const key of ["order", "lang", "ext"]) {
            const value = cur.searchParams.get(key);
            if (value) u.searchParams.set(key, value);
          }
        }
        finalUrl = u.toString();
      } catch {}

      const top = navPath[navPath.length - 1];
      const topIsSearch = !!top && (top.href.includes("/search?") || top.href.includes("?q="));
      await loadFeedWith(client, finalUrl, query, false, topIsSearch ? "replace" : "push");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, feed, filterSel, loadFeedWith, navPath, search]);

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
        // 在线书源导入 = 纯本地：标记后同步引擎不再自动上传云端(2026-09-11)
        if (result.imported.length > 0) {
          await useLibraryStore
            .getState()
            .setBooksCloudExcluded(result.imported.map((b) => b.id))
            .catch((err) => console.warn("[DesktopOpdsBrowser] mark cloudExcluded failed:", err));
        }
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

  // 桌面端返回快捷键 (Backspace 或 Alt+Left)
  useEffect(() => {
    if (!source) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        (e.key === "Backspace" &&
          !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) ||
        (e.altKey && e.key === "ArrowLeft")
      ) {
        if (navPath.length > 1 && !loading && !importBusy) {
          e.preventDefault();
          handleGoBack();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [source, navPath.length, loading, importBusy, handleGoBack]);

  return (
    <>
      <Dialog open={!!source} onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="flex h-[88vh] max-h-[920px] w-[min(95vw,1100px)] flex-col gap-0 overflow-hidden p-0">
          {/* Header 顶部工具栏 (双层桌面式布局：防止小窗下互相挤压) */}
          <DialogHeader className="border-b px-6 pt-4 pb-3.5 pr-16 bg-background/95 backdrop-blur shrink-0">
            <div className="flex flex-col gap-3">
              {/* 第 1 行：导航、当前标题与模式控制 */}
              <div className="flex items-center justify-between gap-3">
                {/* 左侧：返回按钮 + 当前层级名称 */}
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-8 shrink-0 rounded-xl"
                    onClick={handleGoBack}
                    disabled={loading || importBusy || navPath.length <= 1}
                    title={t("common.back", "返回上一级")}
                  >
                    <ArrowLeft className="size-4" />
                  </Button>

                  <div className="min-w-0 flex items-center gap-2">
                    <DialogTitle className="truncate text-base font-semibold">
                      {currentTitle || t("library.opdsCatalogTitle", "在线目录")}
                    </DialogTitle>
                    <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                      OPDS
                    </span>
                  </div>
                </div>

                {/* 右侧：刷新 + 网格/列表切换 */}
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 rounded-xl text-muted-foreground hover:text-foreground"
                    onClick={handleRefresh}
                    disabled={loading || importBusy}
                    title={t("common.refresh", "刷新")}
                  >
                    <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
                  </Button>

                  <div className="flex items-center rounded-xl border border-border bg-muted/30 p-0.5">
                    <button
                      type="button"
                      onClick={() => setViewMode("grid")}
                      className={cn(
                        "rounded-lg p-1.5 transition-colors",
                        viewMode === "grid"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      title={t("library.viewGrid", "网格视图")}
                    >
                      <LayoutGrid className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode("list")}
                      className={cn(
                        "rounded-lg p-1.5 transition-colors",
                        viewMode === "list"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      title={t("library.viewList", "列表视图")}
                    >
                      <List className="size-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              {/* 第 2 行：可交互面包屑路径栏 + 搜索框 */}
              <div className="flex items-center justify-between gap-3">
                {/* 面包屑导航路径 */}
                <div className="flex items-center gap-1 overflow-x-auto text-xs text-muted-foreground scrollbar-none min-w-0 flex-1 py-0.5">
                  {navPath.map((entry, idx) => (
                    <div key={`crumb-${idx}-${entry.href}`} className="flex items-center shrink-0">
                      {idx > 0 && <ChevronRight className="size-3 mx-0.5 text-muted-foreground/50 shrink-0" />}
                      <button
                        type="button"
                        onClick={() => handleJumpToNav(idx)}
                        className={cn(
                          "hover:text-foreground transition-colors truncate max-w-[160px] text-xs",
                          idx === navPath.length - 1
                            ? "font-medium text-foreground cursor-default"
                            : "hover:underline text-muted-foreground",
                        )}
                        disabled={idx === navPath.length - 1 || loading || importBusy}
                      >
                        {entry.title}
                      </button>
                    </div>
                  ))}
                </div>

                {/* 搜索框 (支持回车提交与一键清空) */}
                {hasSearch && (
                  <div className="relative w-48 sm:w-64 shrink-0 flex items-center gap-1.5">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleSearchSubmit();
                        }}
                        className="h-7.5 pl-8 pr-7 text-xs rounded-xl"
                        placeholder={t("library.opdsSearchPlaceholder", "搜索书名或作者...")}
                      />
                      {search && (
                        <button
                          type="button"
                          onClick={() => setSearch("")}
                          className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5"
                        >
                          <X className="size-3" />
                        </button>
                      )}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void handleSearchSubmit()}
                      disabled={loading || !search.trim()}
                      className="h-7.5 px-2.5 rounded-xl text-xs"
                    >
                      {loading ? <Loader2 className="size-3 animate-spin" /> : <Search className="size-3" />}
                    </Button>
                  </div>
                )}
              </div>

              {/* 第 3 行：分面筛选条 (Facets Filter Bar: 排序 / 语言 / 格式) */}
              {feed?.facets && feed.facets.length > 0 && (
                <div className="flex flex-col gap-2 border-t pt-2.5">
                  {Object.entries(
                    feed.facets.reduce<Record<string, OpdsFacet[]>>((acc, facet) => {
                      const group = facet.group || "default";
                      if (!acc[group]) acc[group] = [];
                      acc[group].push(facet);
                      return acc;
                    }, {}),
                  ).map(([groupId, facets]) => {
                    const meta = FACET_GROUP_META[groupId] ?? { label: groupId, inlineLimit: 6 };
                    const paramKey = FACET_PARAM_KEY[groupId];
                    const selectedVal = paramKey && filterSel ? filterSel[paramKey] : "";

                    return (
                      <div key={groupId} className="flex items-center gap-2 overflow-x-auto scrollbar-none py-0.5">
                        <span className="shrink-0 text-[11px] font-semibold text-muted-foreground/80 uppercase">
                          {meta.label}:
                        </span>
                        <div className="flex items-center gap-1.5">
                          {facets.slice(0, meta.inlineLimit).map((facet, fIdx) => {
                            const val = paramKey ? facetValueOf(facet, paramKey) : "";
                            const isSelected = selectedVal === val || (!selectedVal && facet.active);

                            return (
                              <button
                                key={`facet-${groupId}-${fIdx}-${facet.title}`}
                                type="button"
                                onClick={() => handleFacetTap(groupId, facet)}
                                className={cn(
                                  "shrink-0 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-all",
                                  isSelected
                                    ? "bg-primary text-primary-foreground shadow-xs"
                                    : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground",
                                )}
                              >
                                {facet.title}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </DialogHeader>

          {/* 浏览主视区 */}
          <div className="flex-1 overflow-y-auto p-6">
            {loading && !feed ? (
              <div className="flex h-full min-h-80 flex-col items-center justify-center gap-3 text-muted-foreground">
                <Loader2 className="size-7 animate-spin text-primary" />
                <p className="text-sm font-medium">{t("library.opdsLoadingFeed", "正在读取目录...")}</p>
              </div>
            ) : error ? (
              <div className="flex h-full min-h-80 flex-col items-center justify-center gap-4 text-center">
                <div>
                  <p className="text-base font-semibold text-foreground">
                    {t("library.opdsLoadFailed", "读取目录失败")}
                  </p>
                  <p className="mt-1.5 max-w-md text-xs leading-5 text-muted-foreground">{error}</p>
                </div>
                <Button size="sm" onClick={handleRefresh} className="rounded-xl">
                  {t("common.retry", "重试")}
                </Button>
              </div>
            ) : !feed || (feed.navigation.length === 0 && feed.publications.length === 0) ? (
              <div className="flex h-full min-h-80 flex-col items-center justify-center gap-3 text-center">
                <Globe className="size-10 text-muted-foreground/40" />
                <p className="text-base font-semibold text-foreground">
                  {search ? t("library.opdsNoResults", "没有搜到结果") : t("library.opdsListEmptyTitle", "目录为空")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {search ? t("home.tryDifferentSearch") : ""}
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* 1. 分类导航区 (Categories Explorer Tiles) */}
                {feed.navigation.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      <FolderOpen className="size-3.5" />
                      <span>{t("library.opdsCategories", "分类与子目录")}</span>
                      <span className="text-[10px] text-muted-foreground/70">({feed.navigation.length})</span>
                    </div>

                    {/* 网格模式：桌面级垂直文件夹卡片 (类似 macOS Finder / Windows 资源管理器大图标模式) */}
                    {viewMode === "grid" ? (
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3">
                        {feed.navigation.map((nav, index) => {
                          const displayTitle = nav.title?.trim() || t("library.opdsCatalogTitle", "分类目录");
                          return (
                            <button
                              key={`nav-${index}-${nav.href}`}
                              type="button"
                              onClick={() => handleNavPush(nav)}
                              className="group flex flex-col items-center justify-center gap-2 rounded-2xl border border-border/80 bg-card/60 p-3 text-center transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/50 hover:bg-accent/40 hover:shadow-sm select-none"
                              title={displayTitle}
                            >
                              <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary transition-all duration-200 group-hover:scale-105 group-hover:bg-primary group-hover:text-primary-foreground group-hover:shadow-sm">
                                <Folder className="size-5.5" />
                              </div>
                              <span className="line-clamp-2 w-full text-xs font-medium leading-tight text-foreground group-hover:text-primary transition-colors break-words">
                                {displayTitle}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      /* 列表模式：横向通栏列表条目 */
                      <div className="space-y-1.5">
                        {feed.navigation.map((nav, index) => {
                          const displayTitle = nav.title?.trim() || t("library.opdsCatalogTitle", "分类目录");
                          return (
                            <button
                              key={`nav-${index}-${nav.href}`}
                              type="button"
                              onClick={() => handleNavPush(nav)}
                              className="group flex w-full items-center justify-between gap-3 rounded-xl border border-border/80 bg-card/60 px-3.5 py-2.5 text-left transition-all duration-200 hover:border-primary/50 hover:bg-accent/40"
                              title={displayTitle}
                            >
                              <div className="flex items-center gap-3 min-w-0 flex-1">
                                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                                  <FolderOpen className="size-4" />
                                </div>
                                <span className="truncate text-xs font-medium text-foreground group-hover:text-primary transition-colors">
                                  {displayTitle}
                                </span>
                              </div>
                              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* 2. 出版物书籍列表 / 网格 */}
                {feed.publications.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      <div className="flex items-center gap-2">
                        <BookOpen className="size-3.5" />
                        <span>{t("library.opdsBooks", "书目清单")}</span>
                        <span className="text-[10px] text-muted-foreground/70">({feed.publications.length})</span>
                      </div>
                    </div>

                    {/* 网格视图 (Grid View)：自适应 minmax 网格，保证书籍封面永不挤压变形 */}
                    {viewMode === "grid" ? (
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-x-4.5 gap-y-6">
                        {feed.publications.map((pub, index) => {
                          const isDownloadingThis = importBusy && importState.name === pub.title;
                          const isAlreadyInLib = Boolean(
                            findLikelyDuplicateBook(duplicateIndex, { title: pub.title }),
                          );
                          const supportedAcqs = pub.acquisitions
                            .filter((a) => a.priority >= 0)
                            .sort((a, b) => a.priority - b.priority);

                          return (
                            <div
                              key={`pub-grid-${index}-${pub.id ?? pub.title}`}
                              className="group relative flex flex-col cursor-pointer"
                              onClick={() => setSelectedPublication(pub)}
                            >
                              {/* 书籍立体封面 */}
                              <div className="relative w-full">
                                <OpdsBookCover
                                  title={pub.title}
                                  author={pub.authors[0]}
                                  coverUrl={pub.coverUrl}
                                  thumbnailUrl={pub.thumbnailUrl}
                                />

                                {/* 已入库状态小徽标 */}
                                {isAlreadyInLib && (
                                  <div className="absolute top-1.5 left-1.5 z-10 flex items-center gap-1 rounded-full bg-emerald-600/90 px-1.5 py-0.5 text-[10px] font-medium text-white shadow backdrop-blur-sm">
                                    <BookCheck className="size-2.5" />
                                    <span>{t("library.opdsInLibraryTag", "已入库")}</span>
                                  </div>
                                )}

                                {/* 下载中覆盖层 */}
                                {isDownloadingThis && (
                                  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center rounded bg-black/60 backdrop-blur-xs text-white">
                                    <Loader2 className="size-5 animate-spin" />
                                    <span className="mt-1 text-[10px] font-medium">
                                      {importState.phase === "downloading" && importState.percent > 0
                                        ? `${importState.percent}%`
                                        : t("home.downloading")}
                                    </span>
                                  </div>
                                )}

                                {/* 悬浮快捷下载栏 */}
                                {!isDownloadingThis && supportedAcqs.length > 0 && (
                                  <div className="absolute bottom-1.5 right-1.5 z-10 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void runDownload(supportedAcqs[0], pub);
                                      }}
                                      disabled={importBusy}
                                      className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-transform hover:scale-105 active:scale-95"
                                      title={t("library.opdsDownloadRecommended", {
                                        defaultValue: "下载推荐格式 ({{ext}})",
                                        ext: supportedAcqs[0].extension.toUpperCase(),
                                      })}
                                    >
                                      <Download className="size-3.5" />
                                    </button>
                                  </div>
                                )}
                              </div>

                              {/* 书籍标题与作者 */}
                              <div className="mt-2 flex-1 min-w-0">
                                <h4 className="line-clamp-2 text-xs font-medium text-foreground leading-snug group-hover:text-primary transition-colors">
                                  {pub.title}
                                </h4>
                                <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                                  {pub.authors.join(", ") || "—"}
                                </p>
                                <div className="mt-1 flex items-center gap-1 flex-wrap">
                                  {supportedAcqs.slice(0, 2).map((a) => (
                                    <span
                                      key={a.extension}
                                      className="rounded bg-muted px-1 py-0.2 text-[9px] font-medium text-muted-foreground uppercase"
                                    >
                                      {a.extension}
                                    </span>
                                  ))}
                                  {supportedAcqs.length > 2 && (
                                    <span className="text-[9px] text-muted-foreground">
                                      +{supportedAcqs.length - 2}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      /* 列表视图 (List View) */
                      <div className="space-y-2">
                        {feed.publications.map((pub, index) => {
                          const isDownloadingThis = importBusy && importState.name === pub.title;
                          const isAlreadyInLib = Boolean(
                            findLikelyDuplicateBook(duplicateIndex, { title: pub.title }),
                          );
                          const supportedAcqs = pub.acquisitions
                            .filter((a) => a.priority >= 0)
                            .sort((a, b) => a.priority - b.priority);

                          return (
                            <div
                              key={`pub-list-${index}-${pub.id ?? pub.title}`}
                              className="group flex items-center gap-4 rounded-2xl border border-border bg-card p-3 transition-colors hover:border-primary/40 hover:bg-accent/20"
                            >
                              {/* 缩略书封 */}
                              <div
                                className="w-12 shrink-0 cursor-pointer"
                                onClick={() => setSelectedPublication(pub)}
                              >
                                <OpdsBookCover
                                  title={pub.title}
                                  author={pub.authors[0]}
                                  coverUrl={pub.coverUrl}
                                  thumbnailUrl={pub.thumbnailUrl}
                                />
                              </div>

                              {/* 书名、作者与简介 */}
                              <div
                                className="min-w-0 flex-1 cursor-pointer"
                                onClick={() => setSelectedPublication(pub)}
                              >
                                <div className="flex items-center gap-2">
                                  <h4 className="truncate text-sm font-medium text-foreground group-hover:text-primary transition-colors">
                                    {pub.title}
                                  </h4>
                                  {isAlreadyInLib && (
                                    <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                      {t("library.opdsInLibraryTag", "已入库")}
                                    </span>
                                  )}
                                </div>
                                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                  {[pub.authors.join(", "), pub.issued, pub.language]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </p>
                                {pub.summary && (
                                  <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/80">
                                    {pub.summary}
                                  </p>
                                )}
                              </div>

                              {/* 操作按钮区 */}
                              <div className="flex items-center gap-2 shrink-0">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8 rounded-xl text-muted-foreground hover:text-foreground"
                                  onClick={() => setSelectedPublication(pub)}
                                  title={t("library.details", "查看详情")}
                                >
                                  <Info className="size-4" />
                                </Button>

                                {supportedAcqs.length === 0 ? (
                                  <span className="text-xs text-muted-foreground">
                                    {t("library.opdsNoAcquisition", "暂无格式")}
                                  </span>
                                ) : supportedAcqs.length === 1 ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => void runDownload(supportedAcqs[0], pub)}
                                    disabled={importBusy}
                                    className="gap-1.5 rounded-xl text-xs h-8"
                                  >
                                    {isDownloadingThis ? (
                                      <Loader2 className="size-3.5 animate-spin text-primary" />
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
                                        className="gap-1.5 rounded-xl text-xs h-8"
                                      >
                                        {isDownloadingThis ? (
                                          <Loader2 className="size-3.5 animate-spin text-primary" />
                                        ) : (
                                          <Download className="size-3.5" />
                                        )}
                                        <span>{t("library.opdsDownload", "下载")}</span>
                                        <ChevronDown className="size-3 text-muted-foreground" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-48 rounded-xl p-1 shadow-lg">
                                      {supportedAcqs.map((acq, acqIdx) => (
                                        <DropdownMenuItem
                                          key={`acq-${acqIdx}-${acq.extension}`}
                                          onClick={() => void runDownload(acq, pub)}
                                          className="flex items-center justify-between text-xs rounded-lg py-2"
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
                  </div>
                )}

                {/* 分页加载更多 */}
                {feed.nextHref && (
                  <div className="flex justify-center pt-3 pb-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleLoadNext}
                      disabled={loading}
                      className="gap-2 rounded-xl px-4"
                    >
                      {loading && <Loader2 className="size-3.5 animate-spin" />}
                      {t("library.opdsNextPage", "加载更多")}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 底部常驻下载状态指示条 */}
          {importBusy && (
            <div className="border-t bg-muted/40 px-6 py-3">
              <div className="flex items-center gap-3 text-xs font-medium text-foreground">
                <Loader2 className="size-4 animate-spin text-primary shrink-0" />
                <span className="truncate">{statusLabel}</span>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 书籍详情预览抽屉/浮层 */}
      <OpdsBookDetailsModal
        pub={selectedPublication}
        open={!!selectedPublication}
        client={client}
        onClose={() => setSelectedPublication(null)}
        onSelectSimilar={(item) => setSelectedPublication(item)}
        onDownload={(acq) => {
          if (selectedPublication) void runDownload(acq, selectedPublication);
        }}
        isDownloading={importBusy}
        isAlreadyInLibrary={Boolean(
          selectedPublication &&
            findLikelyDuplicateBook(duplicateIndex, { title: selectedPublication.title }),
        )}
      />
    </>
  );
}
