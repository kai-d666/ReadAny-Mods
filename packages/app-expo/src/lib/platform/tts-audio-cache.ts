/**
 * TTS 音频 LRU 缓存(上限 5 条,2026-09-04):
 * 查词发音/其它短句重复朗读时复用合成音频,跳过重复在线合成(几百 ms~2s 延迟)。
 * 键 = engine|voice|text,文件名 = 稳定哈希 + 扩展名;存入 cache/tts-audio-cache/;
 * 满额时按 modificationTime 淘汰最旧一条。缓存只是优化,异常一律静默。
 */
import { Directory, File, Paths } from "expo-file-system";

const CACHE_DIR_NAME = "tts-audio-cache";
const MAX_ENTRIES = 5;

/** 稳定短哈希(djb2 双种子合并;短文本词条,实际碰撞可忽略) */
function hashKey(key: string): string {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = ((h1 * 33) ^ c) >>> 0;
    h2 = ((h2 * 31) + c) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

function cacheDir(): Directory {
  return new Directory(Paths.cache, CACHE_DIR_NAME);
}

/** 命中返回缓存文件 uri;未命中/异常返回 null */
export function getCachedTTSFileUri(key: string, ext: string): string | null {
  try {
    const file = new File(cacheDir(), `${hashKey(key)}.${ext}`);
    return file.exists ? file.uri : null;
  } catch {
    return null;
  }
}

/** 写入缓存(覆盖刷新 mtime),满 5 条时淘汰最旧 */
export function saveTTSAudioCache(key: string, ext: string, bytes: Uint8Array): void {
  try {
    const dir = cacheDir();
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, `${hashKey(key)}.${ext}`);
    file.write(bytes);
    const files = dir.list().filter((e): e is File => e instanceof File);
    if (files.length > MAX_ENTRIES) {
      files
        .filter((f) => f.uri !== file.uri)
        .sort((a, b) => (a.modificationTime ?? 0) - (b.modificationTime ?? 0))
        .forEach((f, i) => {
          if (i < files.length - MAX_ENTRIES) f.delete();
        });
    }
  } catch {
    // 缓存写失败不阻断播放
  }
}

/**
 * 通用"带缓存合成" —— 所有云 TTS 播放器(edge/dashscope/xiaomi/openai)共用:
 * 命中 → 读缓存文件字节(不联网);未命中 → 调 synth() 合成 → 写缓存 → 返回字节。
 * 调用方拿到字节后写自己的临时文件播放;缓存任何异常静默降级为直合。
 */
export async function cachedSynthesize(
  cacheKey: string,
  ext: string,
  logText: string,
  synth: () => Promise<Uint8Array | ArrayBuffer>,
): Promise<Uint8Array> {
  try {
    const cachedUri = getCachedTTSFileUri(cacheKey, ext);
    if (cachedUri) {
      console.log(`[TTSCache] hit: ${logText}`);
      return new Uint8Array(await new File(cachedUri).bytes());
    }
  } catch {
    // 缓存读取失败 → 走合成
  }
  console.log(`[TTSCache] miss: ${logText}`);
  const bytes = new Uint8Array(await synth());
  saveTTSAudioCache(cacheKey, ext, bytes);
  return bytes;
}
