/**
 * LibGen 上游驱动器(内置书源服务端第一个 adapter,2026-09-06)。
 *
 * 数据契约(2026-09-06 实测 libgen.li):
 *   搜索  GET {base}/index.php?req={query}               → HTML 结果表(无验证码)
 *   下载  GET {base}/get.php?md5={md5}                  → 直链流(无验证码)
 *   (部分镜像 json.php 仅剩 object=f&ids 详情形态,不做;HTML 表含全部字段)
 *
 * 镜像策略:按列表顺序尝试,mirrors 内检测"可用"(搜索曾成功记住 activeBase);
 * 默认列表只有镜像根 URL(带协议),上游失败时滑动切换。
 */

import { getPlatformService } from "../../services/platform";
import {
  OPDS_ACQUISITION_PRIORITY,
  OpdsParseError,
  type OpdsFeed,
  type OpdsPublication,
} from "../opds";

/** LibGen 镜像(按可用性排序;libgen.li 为 2026-09 实测可用) */
export const DEFAULT_LIBGEN_MIRRORS = [
  "https://libgen.li",
  "https://libgen.rs",
  "https://libgen.is",
] as const;

export interface LibgenResult {
  md5: string;
  title: string;
  author: string;
  publisher?: string;
  year?: string;
  language?: string;
  size?: number;
  extension?: string;
}

/**
 * 解析 libgen.li 风格结果表 HTML。提取规则:
 * 每行是一个 <tr>;行内若存在 /get.php?md5= 或 /ads.php?md5= 链接才算一条结果
 * (跳过 "Show covers"/"Show chapters" 等控制行)。字段按 <td> 顺序宽松取:
 * 标题/作者/出版社/年/语言/大小/格式,下载链接是强信号。
 */
export function parseLibgenSearchHtml(html: string): LibgenResult[] {
  const results: LibgenResult[] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  for (let rowMatch = rowRegex.exec(html); rowMatch !== null; rowMatch = rowRegex.exec(html)) {
    const row = rowMatch[1];
    const md5 = extractMd5FromRow(row);
    if (!md5) continue;

    const cells = extractCells(row).map((cell) => stripTags(cell).trim());
    // 实际列序(2026-09 实测): title / author / publisher / year / language / desc(页面数) / size / ext / links
    const [titleRaw, authorRaw, publisherRaw, yearRaw, languageRaw, , sizeRaw, extRaw] = cells;

    results.push({
      md5,
      title: titleRaw || "untitled",
      author: authorRaw || "",
      publisher: publisherRaw || undefined,
      year: yearRaw || undefined,
      language: languageRaw || undefined,
      size: parseSize(sizeRaw),
      extension: normalizeExt(extRaw),
    });
  }
  return results;
}

function extractMd5FromRow(row: string): string | null {
  // 优先 /get.php 直链(ads.php 是广告跳转页),均有 md5 时看前半优先
  const getMatch = row.match(/\/get\.php\?md5=([a-f0-9]{32})/i);
  if (getMatch) return getMatch[1];
  const adsMatch = row.match(/\/ads\.php\?md5=([a-f0-9]{32})/i);
  return adsMatch ? adsMatch[1] : null;
}

function extractCells(row: string): string[] {
  const cells: string[] = [];
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  for (let match = cellRegex.exec(row); match !== null; match = cellRegex.exec(row)) {
    cells.push(match[1]);
  }
  return cells;
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSize(raw: string): number | undefined {
  const match = raw.match(/([\d.,]+)\s*(KB|MB|GB)/i);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1].replace(",", "."));
  const unit = match[2].toLowerCase();
  const multiplier = unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : 1024;
  return Math.round(value * multiplier);
}

function normalizeExt(raw: string): string | undefined {
  return (raw.trim().toLowerCase() || undefined) as string | undefined;
}

export class LibgenDriver {
  readonly id: string;
  readonly name: string;

  private readonly mirrors: string[];
  private activeBase: string | null = null;

  constructor(options: { id?: string; name?: string; mirrors?: string[] } = {}) {
    this.id = options.id ?? "libgen";
    this.name = options.name ?? "LibGen";
    this.mirrors = options.mirrors?.length ? options.mirrors : [...DEFAULT_LIBGEN_MIRRORS];
  }

  /** 搜索(对每个镜像依次尝试,成功即记住 activeBase;全部失败抛错) */
  async search(query: string, fetchImpl: Fetcher = defaultFetcher): Promise<LibgenResult[]> {
    let lastError: unknown;
    for (const base of this.currentMirrorOrder()) {
      try {
        const response = await fetchImpl(`${base}/index.php?req=${encodeURIComponent(query)}`, {
          headers: { Accept: "text/html", "User-Agent": UA },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        const results = parseLibgenSearchHtml(html);
        if (results.length === 0) {
          // 空结果可能是镜像返回了非结果页(防呆),但仍视为可用镜像
          this.activeBase = base;
          return [];
        }
        this.activeBase = base;
        return results;
      } catch (error) {
        lastError = error;
      }
    }
    throw new OpdsParseError(
      `LibGen 镜像均不可用: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  /**
   * 转为统一 OpdsFeed(本机服务端用)。
   * downloadBase = 服务端下载代理基址(如 http://127.0.0.1:19090/opds/libgen),
   * 下载 href 一律指向服务端代理(由代理做镜像/路径探测与魔数校验)。
   */
  feedFromResults(
    query: string,
    results: LibgenResult[],
    baseUrl: string,
    downloadBase = "",
  ): OpdsFeed {
    const publications: OpdsPublication[] = results.map((result) => {
      const extension = result.extension;
      const href =
        downloadBase && result.md5
          ? `${downloadBase}/download?md5=${result.md5}`
          : `${this.activeBase ?? this.mirrors[0]}/get.php?md5=${result.md5}`;
      return {
        title: result.title,
        authors: result.author ? [result.author] : [],
        language: result.language,
        issued: result.year,
        summary: [result.publisher, result.year].filter(Boolean).join(" · ") || undefined,
        acquisitions: extension
          ? [
              {
                href,
                type: "",
                extension,
                priority: (OPDS_ACQUISITION_PRIORITY as readonly string[]).indexOf(extension),
              },
            ]
          : [],
      };
    });
    return {
      title: `LibGen · ${query}`,
      href: baseUrl,
      navigation: [],
      publications,
    };
  }

  /**
   * 下载(经服务端代理调用),标准 libgen 两步链:
   *   ① GET /ads.php?md5={md5} → 200 HTML,页内含真实直链 get.php?md5=…&key=…
   *   ② 跟随真实直链 → 文件字节(魔数校验 PK/%PDF)
   * key 短寿命:下载返回 HTML/失败时重新取 ads 页换新 key 再试一次。
   * 按镜像顺序轮换;全部失败抛 OpdsParseError。
   */
  async download(md5: string, fetchImpl: Fetcher = defaultFetcher): Promise<Uint8Array> {
    let lastError: unknown;
    for (const base of this.currentMirrorOrder()) {
      try {
        const realUrl = await resolveLibgenRealLink(base, md5, fetchImpl);
        if (!realUrl) continue;
        // key 可能过期,取一次新 key 重试
        for (let attempt = 0; attempt < 2; attempt++) {
          const url = attempt === 0 ? realUrl : await resolveLibgenRealLink(base, md5, fetchImpl);
          if (!url) break;
          const bytes = await fetchValidLibgenFile(url, fetchImpl);
          if (bytes) {
            console.log(`[LibGen] download ok: ${bytes.length} bytes via ${url}`);
            return bytes;
          }
        }
      } catch (error) {
        lastError = error;
      }
    }
    throw new OpdsParseError(
      `LibGen 下载失败(所有镜像均不可用或过载): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  private currentMirrorOrder(): string[] {
    if (!this.activeBase) return this.mirrors;
    // 活跃镜像优先,其余按注册顺序轮换
    return [this.activeBase, ...this.mirrors.filter((mirror) => mirror !== this.activeBase)];
  }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

/**
 * 从 ads.php 详情页 HTML 提取真实下载链接(参照 pyload-ng/libgen-cli 的成熟模式):
 *   优先 get.php?md5={md5}&key=…;其次 file.php?id=…;再退 direct 文件扩展名直链。
 * 相对 href 以页面基址 resolve;&amp; 实体还原。
 */
export function resolveLibgenRealLink(
  base: string,
  md5: string,
  fetchImpl: Fetcher = defaultFetcher,
): Promise<string | null> {
  return (async () => {
    const response = await fetchImpl(`${base}/ads.php?md5=${md5}`, { responseType: "text" });
    if (!response.ok) return null;
    const html = await response.text();
    const unescapeHref = (href: string) => href.replace(/&amp;/gi, "&");
    const keyed = html.match(/href="([^"]*get\.php\?md5=[a-fA-F0-9]{32}[^"]*)"/i);
    if (keyed) {
      try {
        return new URL(unescapeHref(keyed[1]), base).href;
      } catch {
        // fall through
      }
    }
    const fileId = html.match(/href="([^"]*file\.php\?id=\d+[^"]*)"/i);
    if (fileId) {
      try {
        return new URL(unescapeHref(fileId[1]), base).href;
      } catch {
        // fall through
      }
    }
    const direct = html.match(
      /href="([^"]*(?:upload|download|books)[^"]*\.(?:epub|pdf|mobi|azw3|cbz|fb2)(?:\?[^"]*)?)"/i,
    );
    return direct ? new URL(unescapeHref(direct[1]), base).href : null;
  })();
}

/** 拉取真实链并做魔数校验:仅接受 PK/%PDF 起头的字节;其余(HTML/key 过期等)返回 null */
async function fetchValidLibgenFile(
  url: string,
  fetchImpl: Fetcher = defaultFetcher,
): Promise<Uint8Array | null> {
  const response = await fetchImpl(url, { responseType: "arraybuffer" });
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 16) return null;
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const isPdf =
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  return isZip || isPdf ? bytes : null;
}

/** 注入用 fetch 形状(仅 string URL,与 libgen 调用方一致;responseType 支持二进制下载) */
export type Fetcher = (
  url: string,
  init?: { headers?: Record<string, string>; responseType?: "text" | "arraybuffer" },
) => Promise<Response>;

/**
 * 默认 HTTP 执行器:与书源 UI 同走平台 XHR(统一超时/错误归一);
 * 不直接用 RN 全局 fetch —— 那里无超时与错误包装(网络抖动会被放大成"无法连接")。
 */
const LIBGEN_FETCH_TIMEOUT_MS = 12_000;
const defaultFetcher: Fetcher = (url, init) =>
  getPlatformService().fetch(url, {
    method: "GET",
    headers: init?.headers,
    responseType: init?.responseType ?? "text",
    timeoutMs: LIBGEN_FETCH_TIMEOUT_MS,
  });
