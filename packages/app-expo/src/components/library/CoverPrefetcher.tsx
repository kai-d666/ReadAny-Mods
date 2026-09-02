import { useEffect, useState } from "react";
import { Image, View } from "react-native";

import { useLibraryStore } from "@/stores/library-store";
import { resolveCoverUri } from "@/lib/library/cover-cache";

/**
 * 首屏封面预载:启动(书库数据预热完成)后把**首屏可见的封面**解到
 * Fresco 缓存(内存+磁盘),冷启动打开书库时首帧即显示封面,无"占位→
 * 封面"闪动。只预载首屏(手机 3 列 × 3 行 ≈ 9 本,平板由屏宽决定同样只
 * 取前 9),滚动到后面的书仍走动态解码(行业中默认行为)。
 * 隐藏 Image 尺寸取书卡实际显示尺寸(140×190),Fresco 按目标尺寸下采样
 * 解码,缓存直接可复用。
 */
const VISIBLE_COVER_COUNT = 9;

let hasPrefetched = false;

export function CoverPrefetcher() {
  const books = useLibraryStore((s) => s.books);
  const [uris, setUris] = useState<string[]>([]);

  useEffect(() => {
    if (hasPrefetched || books.length === 0) return;
    hasPrefetched = true;
    (async () => {
      const targets = books
        .filter((b) => !b.deletedAt && b.meta?.coverUrl)
        .slice(0, VISIBLE_COVER_COUNT);
      const resolved: string[] = [];
      for (const b of targets) {
        const uri = await resolveCoverUri(b.id, b.meta.coverUrl);
        if (uri) resolved.push(uri);
      }
      setUris(resolved);
    })();
  }, [books]);

  if (uris.length === 0) return null;
  return (
    <View
      style={{ position: "absolute", top: 0, left: 0, opacity: 0, zIndex: -10 }}
      pointerEvents="none"
    >
      {uris.map((uri) => (
        <Image key={uri} source={{ uri }} style={{ width: 140, height: 190 }} />
      ))}
    </View>
  );
}
