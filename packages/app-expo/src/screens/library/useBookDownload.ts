import { getPlatformService } from "@readany/core/services";
import { SYNC_SECRET_KEYS } from "@readany/core/sync";
import type { Book } from "@readany/core/types";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";

interface UseBookDownloadOptions {
  loadBooks: () => Promise<void>;
  onSuccess: (bookId: string) => void;
}

export function useBookDownload({ loadBooks, onSuccess }: UseBookDownloadOptions) {
  const { t } = useTranslation();
  const [downloadingBookId, setDownloadingBookId] = useState<string | null>(null);
  const [downloadingBookTitle, setDownloadingBookTitle] = useState("");
  const [downloadProgress, setDownloadProgress] = useState<{
    downloaded: number;
    total: number;
  } | null>(null);

  const downloadBook = useCallback(
    async (book: Book) => {
      const bookTitle = book.meta.title || "未知书籍";
      setDownloadingBookId(book.id);
      setDownloadingBookTitle(bookTitle);
      setDownloadProgress(null);

      try {
        const { useSyncStore } = await import("@readany/core/stores/sync-store");
        const { downloadBookFile } = await import("@readany/core/sync");
        const { updateBook } = await import("@readany/core/db/database");

        const syncStore = useSyncStore.getState();
        if (!syncStore.config) {
          setDownloadingBookId(null);
          setDownloadingBookTitle("");
          setDownloadProgress(null);
          Alert.alert(t("common.error", "错误"), t("library.syncNotConfigured", "请先配置同步"));
          return false;
        }

        const platform = getPlatformService();
        const secretKey =
          syncStore.config.type === "webdav" ? SYNC_SECRET_KEYS.webdav : SYNC_SECRET_KEYS.s3;
        const password = await platform.kvGetItem(secretKey);
        if (!password) {
          setDownloadingBookId(null);
          setDownloadingBookTitle("");
          setDownloadProgress(null);
          Alert.alert(
            t("common.error", "错误"),
            t("library.passwordNotFound", "未找到同步密码，请重新配置"),
          );
          return false;
        }

        await updateBook(book.id, { syncStatus: "downloading" });
        await loadBooks();

        const { createSyncBackend } = await import("@readany/core/sync/sync-backend-factory");
        const backend = createSyncBackend(syncStore.config, password);

        const outcome = await downloadBookFile(backend, book.id, book.filePath, (progress) => {
          setDownloadProgress(progress);
        });
        await loadBooks();

        if (!outcome.ok) {
          const err = (outcome.error ?? "").toLowerCase();
          if (err.includes("not found") || err.includes("no content hash")) {
            Alert.alert(
              t("common.error", "错误"),
              t(
                "library.downloadNotFound",
                "远端没有这本书的文件，可能源设备还未上传成功。请回到那台设备重新打开/同步一次，或在此处重新导入。",
              ),
            );
          } else {
            Alert.alert(
              t("common.error", "错误"),
              `${t("library.downloadFailed", "下载失败，请重试")}: ${outcome.error ?? ""}`,
            );
          }
          return false;
        }

        console.log(`[useBookDownload] Book ${book.id} downloaded successfully`);
        const { useVectorModelStore } = await import("@/stores/vector-model-store");
        const vmState = useVectorModelStore.getState();
        if (
          vmState.autoVectorizeOnImport &&
          vmState.vectorModelEnabled &&
          vmState.hasVectorCapability()
        ) {
          const { queueBookForAutoVectorize } = await import("@/lib/rag/auto-vectorize-book");
          queueBookForAutoVectorize({ ...book, syncStatus: "local" }).catch((err) => {
            console.warn(`[useBookDownload] Auto-vectorize enqueue failed for ${book.id}:`, err);
          });
        }
        onSuccess(book.id);
        return true;
      } catch (err) {
        console.error("Download failed:", err);
        Alert.alert(t("common.error", "错误"), t("library.downloadFailed", "下载失败，请重试"));
        return false;
      } finally {
        setDownloadingBookId(null);
        setDownloadingBookTitle("");
        setDownloadProgress(null);
      }
    },
    [loadBooks, onSuccess, t],
  );

  return { downloadingBookId, downloadingBookTitle, downloadProgress, downloadBook };
}
