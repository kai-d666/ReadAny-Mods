/**
 * 本地词典下载/管理(stardict 系,模式同 readany-models 向量模型):
 * - 远程:GitHub Release 直链(kai-d666/ReadAny-Mods/dict-v1)
 * - 本地:<documentDirectory>/readany-dicts/stardict.db + .ready 完成标记
 * - 断点续传(createDownloadResumable);无 .ready → 视为中断,重下
 */

import * as FileSystem from "expo-file-system/legacy";

/** GitHub Release 直链(asset 名与原库一致,重打 release 保持同名即可复用) */
export const DICT_RELEASE_BASE =
  "https://github.com/kai-d666/ReadAny-Mods/releases/download/dict-v1";

export type DictVariant = "mini" | "full";

export interface DictVariantInfo {
  id: DictVariant;
  /** 展示名 */
  label: string;
  /** Release asset 文件名 */
  assetName: string;
  /** 词条规模展示 */
  entries: string;
}

export const DICT_VARIANTS: DictVariantInfo[] = [
  { id: "mini", label: "精选版", assetName: "stardict-android-mini.db", entries: "65 万词条 · ~74MB" },
  { id: "full", label: "全量版", assetName: "stardict-android-full.db", entries: "340 万词条 · ~291MB" },
];

/** 本地词典目录/文件(单一位置,下载哪个版本都落到这里) */
export const DICT_LOCAL_DIR = `${FileSystem.documentDirectory}readany-dicts`;
export const DICT_LOCAL_FILE = `${DICT_LOCAL_DIR}/stardict.db`;
const DICT_READY = `${DICT_LOCAL_DIR}/.ready`;

export interface DictDownloadProgress {
  /** 0..1 */
  fraction: number;
  /** 已下载字节 */
  totalBytesWritten: number;
  /** 总字节 */
  totalBytesExpected: number;
}

export type DictDownloadState =
  | { status: "idle" | "ready" | "error"; error?: string }
  | { status: "downloading"; progress: DictDownloadProgress };

/** 当前本地词典就绪信息;null = 无词典 */
export async function getLocalDictInfo(): Promise<{
  version: DictVariantInfo;
  sizeBytes: number;
} | null> {
  try {
    const ready = await FileSystem.getInfoAsync(DICT_READY);
    if (!ready.exists) return null;
    const file = await FileSystem.getInfoAsync(DICT_LOCAL_FILE);
    if (!file.exists) return null;
    const version = await FileSystem.readAsStringAsync(DICT_READY);
    const info = DICT_VARIANTS.find((v) => v.id === version);
    if (!info) return null;
    return { version: info, sizeBytes: file.size ?? 0 };
  } catch {
    return null;
  }
}

/** 下载(断点续传):已就绪跳过;进度经 onProgress 回调;完成写 .ready */
export async function downloadLocalDict(
  variant: DictVariant,
  onProgress?: (p: DictDownloadProgress) => void,
): Promise<void> {
  const info = DICT_VARIANTS.find((v) => v.id === variant);
  if (!info) throw new Error(`Unknown dict variant: ${variant}`);
  await FileSystem.makeDirectoryAsync(DICT_LOCAL_DIR, { intermediates: true });
  const ready = await FileSystem.getInfoAsync(DICT_READY);
  if (ready.exists && (await FileSystem.getInfoAsync(DICT_LOCAL_FILE)).exists) {
    return; // 已就绪(任意版本),忽略重复下载
  }
  // 中断残留(unready 文件)→ 清掉重下,避免把半截库当缓存
  await FileSystem.deleteAsync(DICT_LOCAL_FILE, { idempotent: true });
  const url = `${DICT_RELEASE_BASE}/${info.assetName}`;
  const job = FileSystem.createDownloadResumable(
    url,
    DICT_LOCAL_FILE,
    {},
    ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
      if (totalBytesExpectedToWrite > 0) {
        onProgress?.({
          fraction: totalBytesWritten / totalBytesExpectedToWrite,
          totalBytesWritten,
          totalBytesExpected: totalBytesExpectedToWrite,
        });
      }
    },
  );
  const result = await job.downloadAsync();
  if (!result) throw new Error("词典下载未完成");
  await FileSystem.writeAsStringAsync(DICT_READY, info.id);
  onProgress?.({ fraction: 1, totalBytesWritten: 1, totalBytesExpected: 1 });
}

/** 删除本地词典(重新下载用) */
export async function deleteLocalDict(): Promise<void> {
  await FileSystem.deleteAsync(DICT_LOCAL_DIR, { idempotent: true });
}
