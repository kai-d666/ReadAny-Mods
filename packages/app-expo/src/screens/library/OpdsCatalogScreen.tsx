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
  SearchIcon,
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
  type OpdsFeed,
  type OpdsPublication,
} from "@readany/core/sources/opds";
import { OpdsClient } from "@readany/core/sources/opds-client";
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
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type Props = NativeStackScreenProps<RootStackParamList, "OpdsCatalog">;

type ImportState =
  | { phase: "idle" }
  | { phase: "downloading"; name: string; loaded: number; total: number }
  | { phase: "importing"; name: string };

type NavPathEntry = { title: string; href: string };

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\[\]{}#%&]/g, "_").trim() || `book-${Date.now()}`;
}

export function OpdsCatalogScreen({ navigation, route }: Props) {
  const { t } = useTranslation();
  const colors = useColors();
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

  // OpenSearch 模板缓存(首次搜索时从 feed.searchHref 懒取)
  const openSearchRef = useRef<{ href: string; template: string } | null>(null);

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
          // 全量刷新(非追加):该目录压入路径栈(栈顶已是同一目录时幂等);
          // 搜索框跟随目录自身的 opensearch
          setNavPath((cur) => {
            const top = cur[cur.length - 1];
            if (top && top.href === href) return cur;
            return [...cur, { title, href }];
          });
          setShowSearch(!!nextFeed.searchHref);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // 初始化:取书源 → 读密码 → 建客户端 → 加载根/路由目录
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = useOpdsSourcesStore.getState().getSource(route.params.sourceId);
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

  const loadRoot = useCallback(() => {
    const last = navPath[navPath.length - 1];
    if (!client || !last) return;
    void loadFeedWith(client, last.href, last.title, false);
  }, [client, navPath, loadFeedWith]);

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
      if (!openSearchRef.current && feed.searchHref) {
        const os = await client.fetchOpenSearch(feed.searchHref);
        openSearchRef.current = { href: feed.searchHref, template: os.template };
      }
      const template = openSearchRef.current?.template;
      if (!template) return;
      const searchUrl = buildOpenSearchUrl(template, query);
      await loadFeedWith(client, searchUrl, `${query}`, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [search, client, feed, loadFeedWith]);

  const handleLoadNext = useCallback(() => {
    if (!client || !feed?.nextHref || loading) return;
    void loadFeedWith(client, feed.nextHref, "", true);
  }, [client, feed?.nextHref, loading, loadFeedWith]);

  const runDownload = useCallback(
    async (acq: OpdsAcquisition, pub: OpdsPublication) => {
      if (!client) return;
      setFormatTarget(null);
      const safeName = sanitizeFilename(pub.title);
      const tmpName = `readany-opds-${Date.now()}-${safeName}.${acq.extension}`;
      const tmpFile = new File(Paths.cache, tmpName);
      try {
        setImportState({ phase: "downloading", name: pub.title, loaded: 0, total: 0 });
        const downloadFile = getPlatformService().downloadFile;
        if (!downloadFile) throw new Error("downloadFile is not available on this platform");
        await downloadFile(acq.href, tmpFile.uri, {
          headers: client.getAuthHeaders(),
          allowInsecure: source?.allowInsecure,
          onProgress: (loaded, total) =>
            setImportState({ phase: "downloading", name: pub.title, loaded, total }),
        });
        setImportState({ phase: "importing", name: pub.title });
        const result = await useLibraryStore.getState().importBooks([
          { uri: tmpFile.uri, name: `${safeName}.${acq.extension}` },
        ]);
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
            <View style={s.navBtn}>
              <CloudDownloadIcon size={16} color={colors.primary} />
            </View>
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
            </View>
          )}
        </View>
      </View>

      {!source || !client ? (
        <View style={s.stateWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : loading && items.length === 0 ? (
        <View style={s.stateWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={s.stateTitle}>{t("library.opdsLoadingFeed", "正在读取目录...")}</Text>
        </View>
      ) : error ? (
        <View style={s.stateWrap}>
          <CloudDownloadIcon size={28} color={colors.destructive} />
          <Text style={s.stateTitle}>{t("library.opdsLoadFailed", "读取目录失败")}</Text>
          <Text style={s.stateDesc}>{error}</Text>
          <TouchableOpacity style={s.retryBtn} onPress={loadRoot} activeOpacity={0.85}>
            <Text style={s.retryBtnText}>{t("common.retry", "重试")}</Text>
          </TouchableOpacity>
        </View>
      ) : items.length === 0 ? (
        <View style={s.stateWrap}>
          <FolderIcon size={28} color={colors.mutedForeground} />
          <Text style={s.stateTitle}>{t("library.opdsNoResults", "没有搜到结果")}</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.key}
          contentContainerStyle={s.listContent}
          onEndReached={handleLoadNext}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loading ? (
              <ActivityIndicator style={s.nextPageSpinner} size="small" color={colors.primary} />
            ) : null
          }
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
                onPress={() => handlePublicationPress(pub)}
                activeOpacity={0.85}
                disabled={importBusy}
              >
                <View style={s.entryIconWrap}>
                  <BookOpenIcon size={18} color={colors.primary} />
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
                  <TouchableOpacity
                    style={s.downloadBtn}
                    onPress={() => handlePublicationPress(pub)}
                    activeOpacity={0.7}
                    accessibilityLabel={t("library.opdsDownload", "下载")}
                  >
                    <CloudDownloadIcon size={16} color={colors.primary} />
                  </TouchableOpacity>
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
    downloadBtn: {
      width: 34,
      height: 34,
      borderRadius: radius.md,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: withOpacity(colors.primary, 0.1),
    },
    nextPageSpinner: { paddingVertical: 12 },
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
