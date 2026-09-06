/**
 * 云书库视图(Koodo importDialog 式,用户拍板 2026-09-03):
 * 云端书目手动列表 → 下载(导入去重入库)/删除云端(文件+封面)。
 * 绑定(上传云端)在书库多选/单书菜单;本页只管"云端拥有"清单。
 */
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { CloudBookEntry } from "@readany/core/sync";
import { getProgressPercent } from "@readany/core/stores/progress-store";
import { getBookProgressPercent } from "@readany/core/utils";
import { useSyncStore } from "@readany/core/stores/sync-store";
import { type ThemeColors, useTheme } from "@/styles/ThemeContext";
import { CloudDownloadIcon, CloudIcon, RefreshCwIcon, Trash2Icon } from "@/components/ui/Icon";

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function CloudLibraryView({ onImported }: { onImported?: () => void }) {
  const { colors, isDark } = useTheme();
  const [entries, setEntries] = useState<CloudBookEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyHash, setBusyHash] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    // 云书库刷新 = 列表先行(书目秒出),同步探测后台跑,完成后重列一次(进度后置嵌入)。
    // 此前仅 listCloudBooks(列目录),进度永远是上次同步的快照,与书库页同步按钮
    // 外观相同语义不同 → 用户"按刷新等于没同步";直接 await 同步又会拖慢慢网进入(2026-09-07)。
    const syncPromise = useSyncStore
      .getState()
      .probeAndSyncNow()
      .catch((error) => {
        console.warn("[CloudLibrary] sync during refresh failed:", error);
      })
      .then(async () => {
        const second = await useSyncStore.getState().listCloudBooks();
        if (!("error" in second)) setEntries(second);
      });
    const result = await useSyncStore.getState().listCloudBooks();
    if ("error" in result) {
      setError(result.error);
      setEntries(null);
      return;
    }
    setEntries(result);
    await syncPromise;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDownload = useCallback(
    async (entry: CloudBookEntry) => {
      setBusyHash(entry.fileHash);
      try {
        const result = await useSyncStore.getState().downloadCloudBook(entry.fileHash);
        if ("error" in result) {
          Alert.alert("下载失败", result.error);
          return;
        }
        if (!result.ok) {
          Alert.alert("下载失败", result.error ?? "未知错误");
          return;
        }
        const { useLibraryStore } = require("@/stores/library-store");
        const importResult = await useLibraryStore
          .getState()
          .importBooks([{ uri: result.localPath!, name: result.fileName }]);
        if (importResult.imported.length > 0) {
          Alert.alert("已导入", `《${entry.title}》已加入书库`);
        } else if (importResult.skippedDuplicates.length > 0) {
          Alert.alert("已在书库", `《${entry.title}》本地已存在,无需重复下载`);
        } else {
          Alert.alert("导入失败", `《${entry.title}》导入时出错,请重试`);
        }
        await useLibraryStore.getState().loadBooks();
        onImported?.();
        await refresh();
      } finally {
        setBusyHash(null);
      }
    },
    [onImported, refresh],
  );

  const handleDelete = useCallback(
    (entry: CloudBookEntry) => {
      Alert.alert(
        "删除云端",
        `确定删除《${entry.title}》在云端的文件吗?本地不受影响。`,
        [
          { text: "取消", style: "cancel" },
          {
            text: "删除",
            style: "destructive",
            onPress: async () => {
              setBusyHash(entry.fileHash);
              try {
                const result = await useSyncStore.getState().deleteCloudBook(entry.fileHash);
                const message = "error" in result ? result.error : null;
                if (message) Alert.alert("删除失败", message);
                await refresh();
              } finally {
                setBusyHash(null);
              }
            },
          },
        ],
      );
    },
    [refresh],
  );

  const styles = makeStyles(colors, isDark);

  if (error) {
    return (
      <View style={styles.center}>
        <CloudIcon size={32} color={colors.mutedForeground} />
        <Text style={styles.mutedText}>{error}</Text>
        <Pressable style={styles.retryBtn} onPress={refresh}>
          <RefreshCwIcon size={16} color={colors.primary} />
          <Text style={styles.retryText}>重试</Text>
        </Pressable>
      </View>
    );
  }

  if (!entries) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.mutedText}>正在同步云端书库…</Text>
      </View>
    );
  }

  if (entries.length === 0) {
    return (
      <View style={styles.center}>
        <CloudIcon size={32} color={colors.mutedForeground} />
        <Text style={styles.mutedText}>云书库空</Text>
        <Text style={styles.hintText}>在书库里长按选择书籍 →「上传云端」即可添加到云书库</Text>
      </View>
    );
  }

  return (
    <View style={styles.rowList}>
      <Text style={styles.listHeader}>云端书库 · {entries.length} 本</Text>
      {entries.map((entry) => {
        // 阅读进度:唯一账本 reading_progress(progress-store 直读)
        const readPercent = getProgressPercent(entry.fileHash);
        return (
        <View key={entry.fileHash} style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {entry.title}
            </Text>
            <Text style={styles.rowSub}>
              {formatBytes(entry.size)}
              {entry.hasRemoteCover ? " · 封面" : ""}
              {readPercent > 0 ? ` · 已读 ${getBookProgressPercent(readPercent)}%` : ""}
            </Text>
          </View>
          {entry.localBookId ? (
            <Text style={styles.importedTag}>已导入</Text>
          ) : (
            <Pressable
              style={[styles.rowBtn, busyHash === entry.fileHash && styles.rowBtnDisabled]}
              disabled={busyHash === entry.fileHash}
              onPress={() => handleDownload(entry)}
            >
              {busyHash === entry.fileHash ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <CloudDownloadIcon size={18} color={colors.primary} />
              )}
            </Pressable>
          )}
          <Pressable
            style={styles.rowBtn}
            disabled={busyHash === entry.fileHash}
            onPress={() => handleDelete(entry)}
          >
            <Trash2Icon size={18} color={colors.destructive} />
          </Pressable>
        </View>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: ThemeColors, isDark: boolean) =>
  StyleSheet.create({
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 10 },
    mutedText: { color: colors.mutedForeground, textAlign: "center" },
    hintText: { color: colors.mutedForeground, fontSize: 12, textAlign: "center" },
    retryBtn: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
    retryText: { color: colors.primary },
    rowList: { paddingHorizontal: 16, paddingTop: 8 },
    listHeader: { color: colors.mutedForeground, fontSize: 12, marginBottom: 8 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { color: colors.foreground, fontSize: 15 },
    rowSub: { color: colors.mutedForeground, fontSize: 12, marginTop: 2 },
    importedTag: {
      color: colors.primary,
      fontSize: 12,
      borderWidth: 1,
      borderColor: colors.primary,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
      overflow: "hidden",
    },
    rowBtn: { padding: 6 },
    rowBtnDisabled: { opacity: 0.4 },
  });
