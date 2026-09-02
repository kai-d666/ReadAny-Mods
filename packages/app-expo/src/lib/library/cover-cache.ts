import { getPlatformService } from "@readany/core/services";

/**
 * bookId → 解析后绝对封面 URI(进程内内存缓存)。
 * BookCard 重挂时同步命中 → 首帧即用正确 URI(封面无"占位→替换"闪动);
 * CoverPrefetcher 启动预载时也写这里,与 BookCard 共享同一份解析结果。
 */
export const coverUriCache = new Map<string, string>();

/**
 * 解析封面 URI(与 BookCard 逻辑一致):http/blob/file 直接返回;
 * 相对路径拼 app data 目录,结果缓存到 coverUriCache。
 */
export async function resolveCoverUri(
  bookId: string,
  coverUrl: string | null | undefined,
): Promise<string | undefined> {
  if (!coverUrl) return undefined;
  if (coverUrl.startsWith("http") || coverUrl.startsWith("blob") || coverUrl.startsWith("file")) {
    return coverUrl;
  }
  const cached = coverUriCache.get(bookId);
  if (cached) return cached;
  const platform = getPlatformService();
  const appData = await platform.getAppDataDir();
  const absPath = await platform.joinPath(appData, coverUrl);
  coverUriCache.set(bookId, absPath);
  return absPath;
}
