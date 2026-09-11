/**
 * OPDS 目录浏览/搜索/下载筛选屏(2026-09-06):
 * 目录导航(子目录)+ OpenSearch 搜索 + 分页(rel=next)+ 下载入库(流式进度)。
 * 下载 → importBooks(唯一入库入口)→ loadBooks;临时文件放 Paths.cache,导入后删除。
 * UI 模板:WebDavImportBrowserScreen(自绘头部/面包屑/搜索框/底部进度条)。
 */
import {
  BookOpenIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloudDownloadIcon,
  FolderIcon,
  Loader2Icon,
  MessageSquareIcon,
  SearchIcon,
  XIcon,
} from "@/components/ui/Icon";
import { OpdsAcquisitionSheet } from "@/components/library/OpdsAcquisitionSheet";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import { useLibraryStore } from "@/stores/library-store";
import {
  fontSize,
  fontWeight,
  radius,
  spacing,
  useColors,
  withOpacity,
} from "@/styles/theme";
import {
  buildOpenSearchUrl,
  type OpdsAcquisition,
  type OpdsFacet,
  type OpdsFeed,
  type OpdsPublication,
} from "@readany/core/sources/opds";
import { OpdsClient } from "@readany/core/sources/opds-client";
import type { ZlibComment } from "@readany/core/sources/driver/zlib";
import { useOpdsSourcesStore } from "@readany/core/sources/opds-source-store";
import { getPlatformService } from "@readany/core/services";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { File, Paths } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

type Props = NativeStackScreenProps<RootStackParamList, "OpdsCatalog">;

type ImportState =
  | { phase: "idle" }
  | { phase: "downloading"; name: string; loaded: number; total: number }
  | { phase: "importing"; name: string };

type NavPathEntry = { title: string; href: string };

/** 分面组显示配置:label + 内联上限(超出部分进"其他"面板;未知组默认 6 内联) */
const FACET_GROUP_META: Record<string, { label: string; inlineLimit: number }> = {
  order: { label: "排序", inlineLimit: Number.MAX_SAFE_INTEGER },
  language: { label: "语言", inlineLimit: 6 },
  format: { label: "格式", inlineLimit: 5 },
};

/** 分面组 → URL 参数键(值从 facet.href 中提取,服务端生成) */
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

/** 字节数 → 人类可读(KB/MB;下载体积展示用) */
function formatBytes(size?: number): string {
  if (!size || size <= 0) return "";
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\[\]{}#%&]/g, "_").trim() || `book-${Date.now()}`;
}

export function OpdsCatalogScreen({ navigation, route }: Props) {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const source = useOpdsSourcesStore((s) =>
    s.sources.find((item) => item.id === route.params.sourceId),
  );

  const [client, setClient] = useState<OpdsClient | null>(null);
  const [navPath, setNavPath] = useState<NavPathEntry[]>([]);
  const [feed, setFeed] = useState<OpdsFeed | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [importState, setImportState] = useState<ImportState>({ phase: "idle" });
  const [formatTarget, setFormatTarget] = useState<OpdsPublication | null>(null);
  /** "其他"面板:长清单组(语言/格式)的完整选项弹层 */
  const [moreGroup, setMoreGroup] = useState<{ id: string; items: OpdsFacet[] } | null>(null);
  /** 本地筛选选择(点选只改状态不刷新;点搜索时才带入请求;初始值来自 feed 的 active 分面) */
  const [filterSel, setFilterSel] = useState<FilterSel | null>(null);
  /** 书籍详情页(单击条目打开;koplugin 同款:封面/元数据/简介 + 底部下载动作) */
  const [detailPub, setDetailPub] = useState<OpdsPublication | null>(null);
  /** 详情页附加交互(koplugin 同款):更多相似书籍 / 简介展开 / 评论 */
  const [similarList, setSimilarList] = useState<OpdsPublication[] | null>(null);
  const [similarBusy, setSimilarBusy] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentsList, setCommentsList] = useState<ZlibComment[] | null>(null);
  const [commentsBusy, setCommentsBusy] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  /** 残条详情补全中(koplugin fetchDetailsThenDownload 同款) */
  const [detailBusy, setDetailBusy] = useState(false);

  // 搜索模板缓存:OPDS-1 从 feed.searchHref 懒取 OpenSearch 文档;OPDS-2 直接内联
  const openSearchRef = useRef<{ href?: string; template: string } | null>(null);

  // 请求序号:快速连点筛选时,过期响应直接丢弃(2026-09-11:防旧响应覆盖新结果 + 面包屑乱叠)
  const loadSeqRef = useRef(0);
  /** 最近一次加载目标(失败也不丢):错误/空态的重试据此重放,而不是"退回"到上一级 */
  const lastLoadRef = useRef<{ href: string; title: string } | null>(null);
  const loadFeedWith = useCallback(
    async (
      activeClient: OpdsClient,
      href: string,
      title: string,
      append: boolean,
      navMode: "push" | "replace" | "none" = "push",
    ) => {
      const seq = ++loadSeqRef.current;
      lastLoadRef.current = { href, title };
      console.log(`[OpdsCatalog] loadFeedWith href=${href} title=${title} append=${append}`);
      setLoading(true);
      setError(null);
      try {
        const nextFeed = await activeClient.fetchFeed(href);
        if (seq !== loadSeqRef.current) return; // 已被更新的请求取代:丢弃
        setFeed((prev) =>
          append && prev
            ? { ...nextFeed, publications: [...prev.publications, ...nextFeed.publications] }
            : nextFeed,
        );
        if (!append && navMode !== "none") {
          // 全量刷新(非追加):路径栈按 navMode 处理(replace=同层换内容,如筛选;push=进入新目录)
          setNavPath((cur) => {
            const top = cur[cur.length - 1];
            if (navMode === "replace" && top && top.href !== href) {
              return [...cur.slice(0, -1), { title, href }];
            }
            if (top && top.href === href) return cur;
            return [...cur, { title, href }];
          });
          setShowSearch(!!(nextFeed.searchHref || nextFeed.searchTemplate));
        }
      } catch (err) {
        if (seq !== loadSeqRef.current) return;
        console.warn(
          `[OpdsCatalog] load failed: ${href} — ${err instanceof Error ? err.message : String(err)}`,
        );
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (seq === loadSeqRef.current) setLoading(false);
      }
    },
    [],
  );

  // 初始化:取书源 → 读密码 → 建客户端 → 加载根/路由目录
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = useOpdsSourcesStore.getState().getSource(route.params.sourceId);
      console.log(
        `[OpdsCatalog] init sourceId=${route.params.sourceId} found=${!!stored}`,
        stored ? { name: stored.name, url: stored.url } : "",
      );
      if (!stored) return;
      const password = await useOpdsSourcesStore.getState().getPassword(route.params.sourceId);
      if (cancelled) return;
      const ready = new OpdsClient(stored, password);
      setClient(ready);
      const root = {
        title: route.params.feedTitle ?? stored.name,
        href: route.params.feedHref ?? stored.url,
      };
      setNavPath([root]);
      await loadFeedWith(ready, root.href, root.title, false);
    })();
    return () => {
      cancelled = true;
    };
  }, [route.params.sourceId, route.params.feedTitle, route.params.feedHref, loadFeedWith]);

  /** 重试/重新搜索:重放最近一次加载目标(修复:原来重试只回退到上级目录,不重发失败请求) */
  const retryLast = useCallback(() => {
    const last = lastLoadRef.current;
    if (!client || !last) return;
    void loadFeedWith(client, last.href, last.title, false);
  }, [client, loadFeedWith]);

  // 导航:当前目录(非根)回退加载上一级;根目录直接返回
  const handleGoBack = useCallback(() => {
    if (navPath.length > 1 && client) {
      const parent = navPath[navPath.length - 2];
      setNavPath(navPath.slice(0, -1));
      if (parent) void loadFeedWith(client, parent.href, parent.title, false);
      return;
    }
    navigation.goBack();
  }, [client, navPath, loadFeedWith, navigation]);

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
          // OPDS-2:模板内联在 catalog 元数据
          openSearchRef.current = { template: feed.searchTemplate };
        } else if (feed.searchHref) {
          const os = await client.fetchOpenSearch(feed.searchHref);
          openSearchRef.current = { href: feed.searchHref, template: os.template };
        }
      }
      const template = openSearchRef.current?.template;
      if (!template) return;
      const searchUrl = buildOpenSearchUrl(template, query);
      // 点搜索才刷新:本地筛选选择(order/lang/ext)在此带入请求
      let finalUrl = searchUrl;
      try {
        const u = new URL(searchUrl);
        if (filterSel) {
          u.searchParams.set("order", filterSel.order);
          if (filterSel.lang) u.searchParams.set("lang", filterSel.lang);
          if (filterSel.ext) u.searchParams.set("ext", filterSel.ext);
        } else if (feed?.href) {
          // 无本地选择(通用源):回退为携带当前视图 URL 的既有参数
          const cur = new URL(feed.href);
          for (const key of ["order", "lang", "ext"]) {
            const value = cur.searchParams.get(key);
            if (value) u.searchParams.set(key, value);
          }
        }
        finalUrl = u.toString();
      } catch {
        // URL 解析失败:按原搜索地址发起
      }
      // 路径处理:当前栈顶已是搜索结果页时,再搜索 = 替换栈顶(面包屑不累积);
      // 从目录/入口页发起搜索才入栈(push)
      const top = navPath[navPath.length - 1];
      const topIsSearch = !!top && top.href.includes("/search?");
      await loadFeedWith(
        client,
        finalUrl,
        `${query}`,
        false,
        topIsSearch ? "replace" : "push",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [search, client, feed, filterSel, navPath, loadFeedWith]);

  const handleLoadNext = useCallback(() => {
    if (!client || !feed?.nextHref || loading) return;
    void loadFeedWith(client, feed.nextHref, "", true);
  }, [client, feed?.nextHref, loading, loadFeedWith]);

  /** 详情动作 URL:从 acquisition href 推导 driver 端点(similar/comments;koplugin 同款路由) */
  const driverEndpointUrl = useCallback((pub: OpdsPublication, endpoint: string): string | null => {
    const acq = pub.acquisitions[0];
    if (!acq) return null;
    try {
      const u = new URL(acq.href);
      u.pathname = u.pathname.replace(/\/download$/, `/${endpoint}`);
      u.searchParams.delete("extension");
      u.searchParams.delete("href");
      return u.toString();
    } catch {
      return null;
    }
  }, []);

  /** 更多相似书籍(koplugin "More Similar Books"):拉取相似书 feed → 列表弹层,点一本直接看它的详情 */
  const handleOpenSimilar = useCallback(
    async (pub: OpdsPublication) => {
      const url = driverEndpointUrl(pub, "similar");
      if (!url || !client) return;
      setSimilarBusy(true);
      try {
        const feed = await client.fetchFeed(url);
        setSimilarList(feed.publications);
      } catch (err) {
        Alert.alert(t("common.failed", "失败"), err instanceof Error ? err.message : String(err));
      } finally {
        setSimilarBusy(false);
      }
    },
    [client, driverEndpointUrl, t],
  );

  /** 评论(koplugin "Comments"):/papi/comments 拉取 → 列表弹层 */
  const handleOpenComments = useCallback(
    async (pub: OpdsPublication) => {
      const url = driverEndpointUrl(pub, "comments");
      if (!url) return;
      setCommentsOpen(true);
      setCommentsBusy(true);
      setCommentsError(null);
      setCommentsList(null);
      try {
        const resp = await getPlatformService().fetch(url, { responseType: "text" });
        const text = await resp.text();
        const data = JSON.parse(text) as { comments?: ZlibComment[] };
        setCommentsList(data.comments ?? []);
      } catch (err) {
        setCommentsError(err instanceof Error ? err.message : String(err));
      } finally {
        setCommentsBusy(false);
      }
    },
    [driverEndpointUrl],
  );

  /** 打开详情:残条(无下载项但有 detailHref,如最热列表)先取详情补全,
   *  拿到 extension 后合成下载入口(koplugin fetchDetailsThenDownload 同款) */
  const openDetail = useCallback(async (pub: OpdsPublication) => {
    setDetailPub(pub);
    setDetailBusy(false);
    if (pub.acquisitions.length > 0 || !pub.detailHref) return;
    setDetailBusy(true);
    try {
      const resp = await getPlatformService().fetch(pub.detailHref, { responseType: "text" });
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
      const b = data.book ?? {};
      const ext = typeof b.extension === "string" ? b.extension.toLowerCase() : "";
      const detailHref = pub.detailHref;
      setDetailPub(() => ({
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
      }));
    } catch (err) {
      console.warn("[OpdsCatalog] detail enrich failed:", err);
    } finally {
      setDetailBusy(false);
    }
  }, []);

  // 分面筛选:纯本地选择(点选立即高亮,不刷新);点搜索时才把选择带入请求
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

  // 分面到达时初始化本地筛选(仅首次;离开带分面的源时清空)
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

  const runDownload = useCallback(
    async (acq: OpdsAcquisition, pub: OpdsPublication) => {
      if (!client) return;
      setFormatTarget(null);
      const safeName = sanitizeFilename(pub.title);
      const tmpName = `readany-opds-${Date.now()}-${safeName}.${acq.extension}`;
      const tmpFile = new File(Paths.cache, tmpName);
      try {
        console.log(`[OpdsCatalog] downloadFile href=${acq.href} title="${pub.title}"`);
        setImportState({ phase: "downloading", name: pub.title, loaded: 0, total: 0 });
        const downloadFile = getPlatformService().downloadFile;
        if (!downloadFile) throw new Error("downloadFile is not available on this platform");
        await downloadFile(acq.href, tmpFile.uri, {
          headers: client.getAuthHeaders(),
          allowInsecure: source?.allowInsecure,
          onProgress: (loaded, total) =>
            setImportState({ phase: "downloading", name: pub.title, loaded, total }),
        });
        // 魔数校验:libgen 等上游忙时可能返回 HTML 错误页(200/500),
        // 存成 epub 会让阅读器"不支持"且元数据全空。epub=PK, pdf=%PDF。
        const extensionLower = acq.extension.toLowerCase();
        if (extensionLower === "epub" || extensionLower === "pdf") {
          const head = (await tmpFile.bytes()).slice(0, 4);
          const isEpub = head[0] === 0x50 && head[1] === 0x4b;
          const isPdf =
            head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
          if (!isEpub && !isPdf) {
            throw new Error(
              t("library.opdsDownloadVerificationFailed", {
                defaultValue: "下载的内容不是有效的电子书(书源服务器可能繁忙),请稍后重试。",
              }),
            );
          }
        }
        setImportState({ phase: "importing", name: pub.title });
        const result = await useLibraryStore.getState().importBooks([
          { uri: tmpFile.uri, name: `${safeName}.${acq.extension}` },
        ]);
        // 在线书源导入 = 纯本地:标记后同步引擎不再自动上传云端(2026-09-11 用户需求)
        if (result.imported.length > 0) {
          await useLibraryStore
            .getState()
            .setBooksCloudExcluded(result.imported.map((b) => b.id))
            .catch((err) => console.warn("[OpdsCatalog] mark cloudExcluded failed:", err));
        }
        await useLibraryStore.getState().loadBooks();
        if (result.imported.length > 0) {
          Alert.alert(
            t("library.opdsImportDoneTitle", "已入库"),
            t("library.opdsImportDone", { defaultValue: "《{{name}}》已加入书库", name: pub.title }),
          );
        } else if (result.skippedDuplicates.length > 0) {
          Alert.alert(
            t("library.opdsImportDoneTitle", "已入库"),
            t("library.opdsImportSkipped", "书库已有同内容书籍，无需重复下载"),
          );
        } else if (result.failures.length > 0) {
          const failure = result.failures[0];
          Alert.alert(
            t("common.failed", "失败"),
            t("library.opdsImportFailed", {
              defaultValue: "导入失败：{{error}}",
              error: failure.error ?? "unknown",
            }),
          );
        }
      } catch (err) {
        Alert.alert(t("common.failed", "失败"), err instanceof Error ? err.message : String(err));
      } finally {
        try {
          if (tmpFile.exists) tmpFile.delete();
        } catch {
          // 忽略临时文件清理失败
        }
        setImportState({ phase: "idle" });
      }
    },
    [client, source?.allowInsecure, t],
  );

  const handlePublicationPress = useCallback(
    (pub: OpdsPublication) => {
      const acqs = pub.acquisitions
        .filter((acq) => acq.priority >= 0)
        .sort((a, b) => a.priority - b.priority);
      if (acqs.length === 0) {
        Alert.alert(t("library.opdsNoAcquisition", "这个条目没有可下载的格式"));
        return;
      }
      if (acqs.length === 1) {
        void runDownload(acqs[0], pub);
        return;
      }
      setFormatTarget(pub);
    },
    [runDownload, t],
  );

  const s = makeStyles(colors);
  const currentTitle = navPath.length > 0 ? navPath[navPath.length - 1].title : (feed?.title ?? "");
  const importBusy = importState.phase !== "idle";
  const pendingName = importBusy ? importState.name : null;

  type ListItem =
    | { kind: "nav"; key: string; title: string; href: string }
    | { kind: "pub"; key: string; pub: OpdsPublication };

  const items: ListItem[] = [
    ...(feed?.navigation ?? []).map(
      (entry, index): ListItem => ({
        kind: "nav",
        key: `nav-${index}-${entry.href}`,
        title: entry.title,
        href: entry.href,
      }),
    ),
    ...(feed?.publications ?? []).map(
      (pub, index): ListItem => ({ kind: "pub", key: `pub-${index}-${pub.id ?? pub.title}`, pub }),
    ),
  ];

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <View style={s.headerInner}>
          <View style={s.headerRow}>
            <TouchableOpacity style={s.navBtn} onPress={handleGoBack} activeOpacity={0.8}>
              <ChevronLeftIcon size={18} color={colors.foreground} />
            </TouchableOpacity>
            <View style={s.headerText}>
              <Text style={s.title} numberOfLines={1}>
                {currentTitle || t("library.opdsCatalogTitle", "在线目录")}
              </Text>
              <Text style={s.subtitle} numberOfLines={1}>
                {source?.url ?? ""}
              </Text>
            </View>
            {/* (原右上角 CloudDownloadIcon 为无点击事件的死装饰,2026-09-11 删除) */}
          </View>
          {navPath.length > 1 && (
            <View style={s.breadcrumbRow}>
              <View style={s.breadcrumbChip}>
                <Text style={s.breadcrumbText} numberOfLines={1}>
                  {navPath.map((entry) => entry.title).join(" › ")}
                </Text>
              </View>
            </View>
          )}
          {showSearch && (
            <View style={s.searchWrap}>
              <SearchIcon size={16} color={colors.mutedForeground} />
              <TextInput
                style={s.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder={t("library.opdsSearchPlaceholder", "搜索书名或作者...")}
                placeholderTextColor={colors.mutedForeground}
                returnKeyType="search"
                onSubmitEditing={() => void handleSearchSubmit()}
              />
              <TouchableOpacity
                style={s.searchBtn}
                onPress={() => void handleSearchSubmit()}
                activeOpacity={0.85}
              >
                <Text style={s.searchBtnText}>{t("common.search", "搜索")}</Text>
              </TouchableOpacity>
            </View>
          )}
          {feed?.facets && feed.facets.length > 0 && (
            <View style={s.facetWrap}>
              {Array.from(new Set(feed.facets.map((f) => f.group))).map((groupId) => {
                const meta = FACET_GROUP_META[groupId] ?? { label: groupId, inlineLimit: 6 };
                const paramKey = FACET_PARAM_KEY[groupId];
                const isActive = (f: OpdsFacet) =>
                  paramKey && filterSel
                    ? facetValueOf(f, paramKey) === filterSel[paramKey]
                    : !!f.active;
                const items = feed.facets?.filter((f) => f.group === groupId) ?? [];
                const overflow = items.length > meta.inlineLimit;
                let inline = overflow ? items.slice(0, meta.inlineLimit) : items;
                // 选中项若被折进"其他",替换末位保证当前状态可见
                const activeItem = items.find(isActive);
                if (overflow && activeItem && !inline.includes(activeItem)) {
                  inline = [...inline.slice(0, -1), activeItem];
                }
                return (
                  <View key={groupId} style={s.facetRow}>
                    <Text style={s.facetGroupLabel}>{meta.label}</Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={s.facetChips}
                      keyboardShouldPersistTaps="handled"
                    >
                      {inline.map((facet) => (
                        <TouchableOpacity
                          key={`${facet.group}-${facet.title}-${facet.href}`}
                          style={[s.facetChip, isActive(facet) && s.facetChipActive]}
                          onPress={() => handleFacetTap(groupId, facet)}
                          activeOpacity={0.8}
                        >
                          <Text style={[s.facetChipText, isActive(facet) && s.facetChipTextActive]}>
                            {facet.title}
                          </Text>
                        </TouchableOpacity>
                      ))}
                      {overflow && (
                        <TouchableOpacity
                          style={s.facetChip}
                          onPress={() => setMoreGroup({ id: groupId, items })}
                          activeOpacity={0.8}
                        >
                          <Text style={s.facetChipText}>
                            {t("library.opdsFacetMore", "其他…")}
                          </Text>
                        </TouchableOpacity>
                      )}
                    </ScrollView>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </View>

      {loading && items.length > 0 && (
        <View style={s.loadBanner}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={s.loadBannerText}>{t("library.opdsLoadingFeed", "正在读取目录...")}</Text>
        </View>
      )}

      {!source || !client ? (
        <View style={s.stateWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : loading && items.length === 0 ? null /* 加载中:仅顶部横幅指示(原全屏转圈已删,与横幅重复) */
      : error ? (
        <View style={s.stateWrap}>
          <CloudDownloadIcon size={28} color={colors.destructive} />
          <Text style={s.stateTitle}>{t("library.opdsLoadFailed", "读取目录失败")}</Text>
          <Text style={s.stateDesc}>{error}</Text>
          <TouchableOpacity style={s.retryBtn} onPress={retryLast} activeOpacity={0.85}>
            <Text style={s.retryBtnText}>{t("common.retry", "重试")}</Text>
          </TouchableOpacity>
        </View>
      ) : items.length === 0 ? (
        <View style={s.stateWrap}>
          <FolderIcon size={28} color={colors.mutedForeground} />
          <Text style={s.stateTitle}>{t("library.opdsNoResults", "没有搜到结果")}</Text>
          <Text style={s.stateDesc}>
            {t("library.opdsNoResultsHint", "换个关键词试试,或调整上方的排序/语言/格式筛选")}
          </Text>
          <TouchableOpacity style={s.retryBtn} onPress={retryLast} activeOpacity={0.85}>
            <Text style={s.retryBtnText}>{t("library.opdsSearchAgain", "重新搜索")}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.key}
          contentContainerStyle={s.listContent}
          onEndReached={handleLoadNext}
          onEndReachedThreshold={0.4}
          renderItem={({ item }) => {
            if (item.kind === "nav") {
              return (
                <TouchableOpacity
                  style={s.entryCard}
                  onPress={() => handleNavPush(item)}
                  activeOpacity={0.85}
                >
                  <View style={s.entryIconWrap}>
                    <FolderIcon size={18} color={colors.primary} />
                  </View>
                  <View style={s.entryText}>
                    <Text style={s.entryTitle} numberOfLines={1}>
                      {item.title}
                    </Text>
                    <Text style={s.entryMeta} numberOfLines={1}>
                      {t("library.opdsCatalogTitle", "在线目录")}
                    </Text>
                  </View>
                  <ChevronRightIcon size={16} color={colors.mutedForeground} />
                </TouchableOpacity>
              );
            }
            const pub = item.pub;
            const isDownloading = pendingName === pub.title;
            const recommended = pub.acquisitions.find((acq) => acq.priority === 0);
            return (
              <TouchableOpacity
                style={s.entryCard}
                onPress={() => void openDetail(pub)}
                activeOpacity={0.85}
                disabled={importBusy}
              >
                <View style={pub.thumbnailUrl ? s.entryCoverWrap : s.entryIconWrap}>
                  {pub.thumbnailUrl ? (
                    <Image
                      source={{ uri: pub.thumbnailUrl }}
                      style={s.entryCover}
                      resizeMode="cover"
                    />
                  ) : (
                    <BookOpenIcon size={18} color={colors.primary} />
                  )}
                </View>
                <View style={s.entryText}>
                  <Text style={s.entryTitle} numberOfLines={2}>
                    {pub.title}
                  </Text>
                  <Text style={s.entryMeta} numberOfLines={1}>
                    {[
                      pub.authors.join(" / "),
                      pub.language,
                      pub.issued,
                      pub.acquisitions.length > 0
                        ? pub.acquisitions.map((acq) => acq.extension.toUpperCase()).join(" · ")
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                  {recommended && pub.acquisitions.length > 1 && (
                    <View style={s.badge}>
                      <Text style={s.badgeText}>
                        {t("library.opdsRecommended", "推荐")} · {recommended.extension.toUpperCase()}
                      </Text>
                    </View>
                  )}
                </View>
                {isDownloading ? (
                  <Loader2Icon size={16} color={colors.primary} />
                ) : (
                  <ChevronRightIcon size={16} color={colors.mutedForeground} />
                )}
              </TouchableOpacity>
            );
          }}
        />
      )}

      {importBusy && (
        <View pointerEvents="none" style={s.progressWrap}>
          <View style={s.progressInner}>
            <Text style={s.progressTitle} numberOfLines={1}>
              {importState.phase === "downloading"
                ? t("library.opdsDownloading", {
                    defaultValue: "正在下载 {{name}} {{percent}}%",
                    name: importState.name,
                    percent:
                      importState.total > 0
                        ? Math.min(99, Math.round((importState.loaded / importState.total) * 100))
                        : "?",
                  })
                : t("library.opdsImporting", {
                    defaultValue: "正在导入 {{name}}...",
                    name: importState.name,
                  })}
            </Text>
            {importState.phase === "downloading" && importState.total > 0 && (
              <View style={s.progressTrack}>
                <View
                  style={[
                    s.progressFill,
                    { width: `${Math.min(100, Math.round((importState.loaded / importState.total) * 100))}%` },
                  ]}
                />
              </View>
            )}
          </View>
        </View>
      )}

      <OpdsAcquisitionSheet
        visible={formatTarget !== null}
        publication={formatTarget}
        onPick={(acq) => {
          const target = formatTarget;
          if (target) void runDownload(acq, target);
        }}
        onClose={() => setFormatTarget(null)}
      />

      {detailPub && (
        <Modal visible animationType="slide" onRequestClose={() => setDetailPub(null)}>
          {/* 全屏弹层:状态栏/三键避让用 app 统一方式(react-native-safe-area-context) */}
          <View style={[s.detailRoot, { paddingTop: insets.top }]}>
            <View style={s.detailHeader}>
              <Text style={s.detailHeaderTitle} numberOfLines={1}>
                {detailPub.title}
              </Text>
              <TouchableOpacity
                onPress={() => setDetailPub(null)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.7}
              >
                <XIcon size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={s.detailScrollContent}>
              <View style={s.detailTop}>
                {detailPub.coverUrl || detailPub.thumbnailUrl ? (
                  <Image
                    source={{ uri: detailPub.coverUrl ?? detailPub.thumbnailUrl }}
                    style={s.detailCover}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={[s.detailCover, s.detailCoverEmpty]}>
                    <BookOpenIcon size={32} color={colors.mutedForeground} />
                  </View>
                )}
                <View style={s.detailInfo}>
                  <Text style={s.detailTitle}>{detailPub.title}</Text>
                  {detailPub.authors.length > 0 && (
                    <Text style={s.detailAuthors}>{detailPub.authors.join(" / ")}</Text>
                  )}
                  {(detailPub.publisher || detailPub.issued) && (
                    <Text style={s.detailMetaLine}>
                      {[detailPub.publisher, detailPub.issued].filter(Boolean).join(" · ")}
                    </Text>
                  )}
                  <Text style={s.detailMetaLine}>
                    {[
                      detailPub.language,
                      formatBytes(detailPub.acquisitions[0]?.size),
                      detailPub.extent ? `${detailPub.extent} 页` : "",
                      detailPub.acquisitions.map((a) => a.extension.toUpperCase()).join(" / "),
                    ]
                      .filter(Boolean)
                      .join(" | ")}
                  </Text>
                </View>
              </View>

              <View style={s.detailDivider}>
                <View style={s.detailDividerLine} />
                <Text style={s.detailDividerText}>{t("library.opdsProfile", "简介")}</Text>
                <View style={s.detailDividerLine} />
              </View>
              <Text style={s.detailDesc}>
                {detailPub.summary || t("library.opdsNoSummary", "暂无简介")}
              </Text>

              {/* 动作行(koplugin 同款:更多相似书籍 / 简介 / 评论) */}
              <View style={s.detailActionList}>
                <TouchableOpacity
                  style={s.detailActionRow}
                  onPress={() => void handleOpenSimilar(detailPub)}
                  activeOpacity={0.8}
                  disabled={similarBusy}
                >
                  <SearchIcon size={18} color={colors.foreground} />
                  <Text style={s.detailActionText}>
                    {t("library.opdsMoreSimilar", "更多相似书籍")}
                  </Text>
                  {similarBusy ? <ActivityIndicator size="small" color={colors.primary} /> : null}
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.detailActionRow}
                  onPress={() => void handleOpenComments(detailPub)}
                  activeOpacity={0.8}
                >
                  <MessageSquareIcon size={18} color={colors.foreground} />
                  <Text style={s.detailActionText}>{t("library.opdsComments", "评论")}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>

            {detailBusy ? (
              <View style={[s.detailActions, { paddingBottom: spacing.lg + insets.bottom }]}>
                <View style={s.detailBusyRow}>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={s.detailBusyText}>
                    {t("library.opdsDetailLoading", "正在获取下载信息…")}
                  </Text>
                </View>
              </View>
            ) : detailPub.acquisitions.length > 0 ? (
              <View style={[s.detailActions, { paddingBottom: spacing.lg + insets.bottom }]}>
                <TouchableOpacity
                  style={s.detailDownloadBtn}
                  onPress={() => {
                    const target = detailPub;
                    setDetailPub(null);
                    handlePublicationPress(target);
                  }}
                  activeOpacity={0.85}
                >
                  <CloudDownloadIcon size={16} color={colors.background} />
                  <Text style={s.detailDownloadText}>
                    {t("library.opdsDownloadWithExt", {
                      defaultValue: "下载 ({{ext}})",
                      ext: detailPub.acquisitions
                        .map((a) => a.extension.toUpperCase())
                        .join(" / "),
                    })}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        </Modal>
      )}

      {similarList && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setSimilarList(null)}>
          <TouchableOpacity
            style={s.facetModalOverlay}
            activeOpacity={1}
            onPress={() => setSimilarList(null)}
          >
            <View style={s.facetModalCard} onStartShouldSetResponder={() => true}>
              <Text style={s.facetModalTitle}>
                {t("library.opdsMoreSimilar", "更多相似书籍")}
              </Text>
              <ScrollView style={s.facetModalScroll} keyboardShouldPersistTaps="handled">
                {similarList.length === 0 ? (
                  <Text style={s.subModalEmpty}>{t("library.opdsNoResults", "没有搜到结果")}</Text>
                ) : (
                  similarList.map((pub) => (
                    <TouchableOpacity
                      key={`${pub.id ?? pub.title}`}
                      style={s.similarRow}
                      onPress={() => {
                        setSimilarList(null);
                        void openDetail(pub);
                      }}
                      activeOpacity={0.75}
                    >
                      {pub.thumbnailUrl ? (
                        <Image
                          source={{ uri: pub.thumbnailUrl }}
                          style={s.similarCover}
                          resizeMode="cover"
                        />
                      ) : (
                        <View style={[s.similarCover, s.similarCoverEmpty]}>
                          <BookOpenIcon size={14} color={colors.mutedForeground} />
                        </View>
                      )}
                      <View style={s.similarTextCol}>
                        <Text style={s.similarTitle} numberOfLines={2}>
                          {pub.title}
                        </Text>
                        {pub.authors.length > 0 && (
                          <Text style={s.similarMeta} numberOfLines={1}>
                            {pub.authors.join(" / ")}
                          </Text>
                        )}
                      </View>
                    </TouchableOpacity>
                  ))
                )}
              </ScrollView>
            </View>
          </TouchableOpacity>
        </Modal>
      )}

      {commentsOpen && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setCommentsOpen(false)}>
          <TouchableOpacity
            style={s.facetModalOverlay}
            activeOpacity={1}
            onPress={() => setCommentsOpen(false)}
          >
            <View style={s.facetModalCard} onStartShouldSetResponder={() => true}>
              <Text style={s.facetModalTitle}>{t("library.opdsComments", "评论")}</Text>
              {commentsBusy ? (
                <View style={s.subModalBusy}>
                  <ActivityIndicator size="small" color={colors.primary} />
                </View>
              ) : commentsError ? (
                <Text style={s.subModalEmpty}>{commentsError}</Text>
              ) : (
                <ScrollView style={s.facetModalScroll} keyboardShouldPersistTaps="handled">
                  {(commentsList ?? []).length === 0 ? (
                    <Text style={s.subModalEmpty}>{t("library.opdsNoComments", "暂无评论")}</Text>
                  ) : (
                    (commentsList ?? []).map((comment, index) => (
                      <View key={`${comment.id ?? index}`} style={s.commentRow}>
                        <Text style={s.commentMeta} numberOfLines={1}>
                          {comment.user}
                          {comment.premium ? " ⭐" : ""}
                          {comment.date ? ` · ${comment.date}` : ""}
                        </Text>
                        <Text style={s.commentText}>{comment.text}</Text>
                      </View>
                    ))
                  )}
                </ScrollView>
              )}
            </View>
          </TouchableOpacity>
        </Modal>
      )}

      {moreGroup && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setMoreGroup(null)}>
          <TouchableOpacity
            style={s.facetModalOverlay}
            activeOpacity={1}
            onPress={() => setMoreGroup(null)}
          >
            <View style={s.facetModalCard} onStartShouldSetResponder={() => true}>
              <Text style={s.facetModalTitle}>
                {FACET_GROUP_META[moreGroup.id]?.label ?? moreGroup.id}
              </Text>
              <ScrollView style={s.facetModalScroll} keyboardShouldPersistTaps="handled">
                {moreGroup.items.map((facet) => {
                  const pk = FACET_PARAM_KEY[moreGroup.id];
                  const active =
                    pk && filterSel ? facetValueOf(facet, pk) === filterSel[pk] : !!facet.active;
                  return (
                    <TouchableOpacity
                      key={`${facet.group}-${facet.title}`}
                      style={s.facetModalItem}
                      onPress={() => {
                        handleFacetTap(moreGroup.id, facet);
                        setMoreGroup(null);
                      }}
                      activeOpacity={0.7}
                    >
                      <Text style={[s.facetModalItemText, active && s.facetModalItemTextActive]}>
                        {facet.title}
                      </Text>
                      {active && <Text style={s.facetModalCheck}>✓</Text>}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          </TouchableOpacity>
        </Modal>
      )}
    </SafeAreaView>
  );
}

const makeStyles = (colors: {
  background: string;
  card: string;
  border: string;
  foreground: string;
  mutedForeground: string;
  primary: string;
  destructive: string;
}) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    headerInner: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
      paddingBottom: spacing.sm,
      maxWidth: 720,
      width: "100%",
      alignSelf: "center",
    },
    headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    navBtn: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.md,
    },
    headerText: { flex: 1, minWidth: 0 },
    title: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.foreground },
    subtitle: { fontSize: fontSize.xs, color: colors.mutedForeground, marginTop: 2 },
    breadcrumbRow: { flexDirection: "row", marginTop: 4 },
    breadcrumbChip: {
      maxWidth: "100%",
      borderRadius: radius.md,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    breadcrumbText: { fontSize: fontSize.xs, color: colors.mutedForeground },
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 8,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      paddingHorizontal: 10,
    },
    // 搜索按钮(点按立即搜索,筛选随请求携带;不止键盘回车)
    searchBtn: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: radius.md,
      backgroundColor: colors.primary,
    },
    searchBtnText: {
      fontSize: fontSize.sm,
      fontWeight: fontWeight.medium,
      color: colors.background,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 7,
      fontSize: fontSize.sm,
      color: colors.foreground,
    },
    stateWrap: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      paddingHorizontal: spacing.xl,
    },
    stateTitle: { fontSize: fontSize.base, fontWeight: fontWeight.medium, color: colors.foreground },
    stateDesc: {
      fontSize: fontSize.sm,
      color: colors.mutedForeground,
      textAlign: "center",
      lineHeight: 20,
    },
    retryBtn: {
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 20,
      paddingVertical: 8,
      marginTop: 8,
    },
    retryBtnText: { fontSize: fontSize.sm, color: colors.foreground },
    listContent: { padding: spacing.md, gap: spacing.sm, paddingBottom: 96 },
    entryCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: colors.card,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
    },
    entryIconWrap: {
      width: 34,
      height: 34,
      borderRadius: radius.md,
      backgroundColor: withOpacity(colors.primary, 0.12),
      alignItems: "center",
      justifyContent: "center",
    },
    // ZL 等在线源搜索结果自带封面缩略图(koplugin 同款体验)
    entryCoverWrap: {
      width: 40,
      height: 56,
      borderRadius: radius.md,
      overflow: "hidden",
      backgroundColor: withOpacity(colors.primary, 0.12),
    },
    entryCover: { width: "100%", height: "100%" },
    // 分面筛选行(ZL 排序/语言/格式;横向滚动 chips)
    facetWrap: { marginTop: spacing.xs, gap: 4 },
    facetRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
    facetGroupLabel: { fontSize: fontSize.xs, color: colors.mutedForeground, width: 28 },
    facetChips: { flexDirection: "row", gap: 6, alignItems: "center" },
    facetChip: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
    },
    facetChipActive: {
      borderColor: colors.primary,
      backgroundColor: withOpacity(colors.primary, 0.1),
    },
    facetChipText: { fontSize: fontSize.xs, color: colors.foreground },
    facetChipTextActive: { color: colors.primary, fontWeight: fontWeight.medium },
    // "其他"面板(语言/格式长清单)
    facetModalOverlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.4)",
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: spacing.xl,
    },
    facetModalCard: {
      width: "100%",
      maxWidth: 340,
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      paddingVertical: spacing.md,
      gap: spacing.xs,
    },
    facetModalTitle: {
      fontSize: fontSize.base,
      fontWeight: fontWeight.semibold,
      color: colors.foreground,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.xs,
    },
    facetModalScroll: { maxHeight: 420 },
    facetModalItem: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: spacing.lg,
      paddingVertical: 11,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    facetModalItemText: { flex: 1, fontSize: fontSize.sm, color: colors.foreground },
    facetModalItemTextActive: { color: colors.primary, fontWeight: fontWeight.medium },
    facetModalCheck: { fontSize: fontSize.sm, color: colors.primary, marginLeft: 8 },
    // 加载横幅(列表非空时的刷新提示)
    loadBanner: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 8,
      backgroundColor: withOpacity(colors.primary, 0.08),
    },
    loadBannerText: { fontSize: fontSize.xs, color: colors.primary, fontWeight: fontWeight.medium },
    // 书籍详情页(koplugin 同款布局:大封面 + 元数据 + 简介 + 底部下载)
    detailRoot: { flex: 1, backgroundColor: colors.background },
    detailHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    detailHeaderTitle: {
      flex: 1,
      fontSize: fontSize.base,
      fontWeight: fontWeight.semibold,
      color: colors.foreground,
    },
    detailScrollContent: { padding: spacing.lg, gap: spacing.md },
    detailTop: { flexDirection: "row", gap: spacing.md },
    detailCover: {
      width: 110,
      height: 160,
      borderRadius: radius.md,
      backgroundColor: withOpacity(colors.primary, 0.12),
    },
    detailCoverEmpty: { alignItems: "center", justifyContent: "center" },
    detailInfo: { flex: 1, gap: 6 },
    detailTitle: {
      fontSize: fontSize.base,
      fontWeight: fontWeight.semibold,
      color: colors.foreground,
      lineHeight: 22,
    },
    detailAuthors: { fontSize: fontSize.sm, color: colors.primary },
    detailMetaLine: { fontSize: fontSize.sm, color: colors.mutedForeground, lineHeight: 20 },
    detailDivider: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.sm },
    detailDividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
    detailDividerText: { fontSize: fontSize.xs, color: colors.mutedForeground },
    detailDesc: { fontSize: fontSize.sm, color: colors.foreground, lineHeight: 22 },
    // 详情动作行(koplugin 同款)
    detailActionList: { marginTop: spacing.sm },
    detailActionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 13,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    detailActionText: {
      flex: 1,
      fontSize: fontSize.sm,
      fontWeight: fontWeight.medium,
      color: colors.foreground,
    },
    subModalEmpty: {
      padding: 16,
      fontSize: fontSize.sm,
      color: colors.mutedForeground,
      textAlign: "center",
    },
    subModalBusy: { padding: 24, alignItems: "center" },
    // 相似书籍行
    similarRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: spacing.lg,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    similarCover: {
      width: 34,
      height: 48,
      borderRadius: radius.sm,
      backgroundColor: withOpacity(colors.primary, 0.12),
    },
    similarCoverEmpty: { alignItems: "center", justifyContent: "center" },
    similarTextCol: { flex: 1, minWidth: 0 },
    similarTitle: { fontSize: fontSize.sm, color: colors.foreground, fontWeight: fontWeight.medium },
    similarMeta: { fontSize: fontSize.xs, color: colors.mutedForeground, marginTop: 2 },
    // 评论行
    commentRow: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: 4,
    },
    commentMeta: { fontSize: fontSize.xs, color: colors.primary, fontWeight: fontWeight.medium },
    commentText: { fontSize: fontSize.sm, color: colors.foreground, lineHeight: 20 },
    detailActions: {
      padding: spacing.lg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    detailDownloadBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 12,
      borderRadius: radius.md,
      backgroundColor: colors.primary,
    },
    detailDownloadText: {
      fontSize: fontSize.sm,
      fontWeight: fontWeight.medium,
      // 本屏 colors 子集无 primaryForeground:深色主题下 primary 上的文字用背景色反白
      color: colors.background,
    },
    detailBusyRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
    detailBusyText: { fontSize: fontSize.sm, color: colors.mutedForeground },
    entryText: { flex: 1, minWidth: 0 },
    entryTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.foreground },
    entryMeta: { fontSize: fontSize.xs, color: colors.mutedForeground, marginTop: 2 },
    badge: {
      alignSelf: "flex-start",
      borderRadius: radius.sm,
      backgroundColor: withOpacity(colors.primary, 0.12),
      paddingHorizontal: 6,
      paddingVertical: 2,
      marginTop: 4,
    },
    badgeText: { fontSize: fontSize.xs, color: colors.primary, fontWeight: fontWeight.medium },
    progressWrap: {
      position: "absolute",
      left: 12,
      right: 12,
      bottom: 24,
      zIndex: 50,
    },
    progressInner: {
      borderRadius: radius.lg,
      backgroundColor: "rgba(0,0,0,0.82)",
      padding: 12,
    },
    progressTitle: { color: "#fff", fontSize: fontSize.sm, fontWeight: fontWeight.medium },
    progressTrack: {
      height: 4,
      backgroundColor: "rgba(255,255,255,0.24)",
      borderRadius: 2,
      overflow: "hidden",
      marginTop: 8,
    },
    progressFill: {
      height: "100%",
      backgroundColor: colors.primary,
      borderRadius: 2,
    },
  });
