/**
 * reader.html(2MB,foliate-js bundle)asset 共享预加载。
 *
 * dev 模式下 asset 首次从 Metro 下载(约 1.6s),若等到进入阅读页才下载,
 * 每次冷启动后第一次打开书都会卡 1.6s+。App 启动时后台预下载,进入
 * 阅读页时秒取;多调用方共享同一个下载 Promise(不会重复下载)。
 */
import { Asset } from "expo-asset";

const READER_HTML_ASSET = Asset.fromModule(require("../../../assets/reader/reader.html"));

let preloadPromise: Promise<void> | null = null;

/** 后台预下载 reader.html,幂等;失败后允许下次重试 */
export function preloadReaderHtmlAsset(): Promise<void> {
  if (!preloadPromise) {
    preloadPromise = READER_HTML_ASSET.downloadAsync()
      .then(() => undefined)
      .catch((err) => {
        preloadPromise = null; // 失败可重试
        console.warn("[ReaderHtmlAsset] preload failed:", err);
        throw err;
      });
  }
  return preloadPromise;
}

/** 取 reader.html 本地 URI;未预下载则先下载 */
export async function getReaderHtmlUri(): Promise<string | null> {
  try {
    await preloadReaderHtmlAsset();
    return getReaderHtmlUriSync();
  } catch {
    return null;
  }
}

/** 同步取本地 URI(仅已下载时非 null);已预下载时 WebView 可首帧创建,不等 effect */
export function getReaderHtmlUriSync(): string | null {
  if (!READER_HTML_ASSET.downloaded) return null;
  return READER_HTML_ASSET.localUri || READER_HTML_ASSET.uri || null;
}
