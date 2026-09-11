/**
 * Z-Library 上游驱动器(2026-09-08 按 zlibrary.koplugin 1.0.49 规格翻修)。
 *
 * 契约(与 KOReader 插件 ZlibraryKO/zlibrary.koplugin 实测一致):
 *   登录  POST {base}/rpc.php            body: isModal/action=login/email/password/…
 *         → { errors, response:{ user_id, user_key } }(即网站会话对,后续走 Cookie)
 *   搜索  POST {base}/eapi/book/search   body: message, limit, page(免登录可搜)
 *         → { success, books: [{ id, hash, name, author…, extension, year, language, href }] }
 *   下载  两步:GET {base}/eapi/book/{id}/{hash}/file → { success, file:{ downloadLink, allowDownload } }
 *          然后 GET downloadLink(签名直链,带 Cookie + Referer)
 * 认证 = Cookie: remix_userid=…; remix_userkey=…(不再是自定义 header —— 上次失败的根因之一)。
 *
 * 镜像策略(对齐 koplugin):种子域 + 官方域清单端点刷新 + /eapi/info/ok 健康检查;
 * DiamWall 挑战页(307/513/"Verifying your browser" 等)只识别、标注黑名单、换家 ——
 * 挑战页是运营方故意行为,不尝试绕过(koplugin 同立场)。
 */
import {
  defaultFetcher,
  looksLikeBookFile,
  type Fetcher,
} from "./fetcher";
import {
  OPDS_ACQUISITION_PRIORITY,
  OpdsParseError,
  type OpdsFacet,
  type OpdsFeed,
  type OpdsPublication,
} from "../opds";
import type { BookSourceDriver } from "./local-opds-server";
import { ZL_MORE_LANGUAGES } from "./zlib-languages";
import { getPlatformService } from "../../services/platform";

// UA 候选:koplugin 同款桌面 Chrome(2026-09-08 探测:24 域通过,大多数域对其放行);
// App 串仅作回退(部分域两者都放行)。
const ZLIB_UA_CANDIDATES = [
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36",
  "zlibrary-app/0.8.5 (Android 13; API 33)",
];

// 种子镜像域(2026-09-08 探测:34 域中 24 域 eAPI 通;此处取探测通过且响应稳定的 12 个)。
// 运行时还会并入官方 /eapi/info/domains/singlelogin 清单。
const ZL_SEED_DOMAINS = [
  "z-lib.bz",
  "z-lib.gd",
  "z-lib.gl",
  "article.sk",
  "articles.sk",
  "bookabooki.fi",
  "bookabooki.tw",
  "z-library.ec",
  "z-lib.fo",
  "lexlib.fi",
  "lexlib.tw",
  "librella.fi",
];

// 大文件下载超时:默认 15s 会把 > 10MB 的书在慢网下掐断
// (koplugin 对下载流无总超时,仅低速保护;此处取 5 分钟折中,避免挂死连接无限等待)
const ZL_DOWNLOAD_TIMEOUT_MS = 300_000;

// 搜索筛选分面(全量对齐 koplugin:SUPPORTED_ORDERS 8 项 / SUPPORTED_EXTENSIONS 12 项 /
// SUPPORTED_LANGUAGES 191 项——高频 6 项内联,其余 185 项在 zlib-languages.ts)
const ZL_ORDER_OPTIONS = [
  { value: "bestmatch", label: "最佳匹配" },
  { value: "popular", label: "最热" },
  { value: "date", label: "最新" },
  { value: "titleA", label: "书名 A-Z" },
  { value: "title", label: "书名 Z-A" },
  { value: "year", label: "年份" },
  { value: "filesize", label: "体积 ↓" },
  { value: "filesizeA", label: "体积 ↑" },
];
// 高频语言在前(UI 内联这 6 项,其余走"其他"面板)
const ZL_LANGUAGE_OPTIONS = [
  { value: "english", label: "英文" },
  { value: "chinese", label: "中文" },
  { value: "french", label: "法文" },
  { value: "german", label: "德文" },
  { value: "spanish", label: "西语" },
  { value: "russian", label: "俄文" },
  ...ZL_MORE_LANGUAGES,
];
// 常见格式在前(UI 内联前 5 项,其余走"其他"面板);值用大写,与 koplugin 表单一致
const ZL_EXTENSION_OPTIONS = [
  { value: "EPUB", label: "EPUB" },
  { value: "PDF", label: "PDF" },
  { value: "MOBI", label: "MOBI" },
  { value: "AZW3", label: "AZW3" },
  { value: "FB2", label: "FB2" },
  { value: "AZW", label: "AZW" },
  { value: "CBZ", label: "CBZ" },
  { value: "DJV", label: "DJV" },
  { value: "DJVU", label: "DJVU" },
  { value: "LIT", label: "LIT" },
  { value: "RTF", label: "RTF" },
  { value: "TXT", label: "TXT" },
];

// DiamWall/Cloudflare 挑战页特征(koplugin api.lua 同清单);命中 = 该域拒绝自动化,换家
const CHALLENGE_RE =
  /Verifying your browser|DiamWall|cdn-cgi\/mitigation|Just a moment|Checking your browser|cf-chl|__cf_chl/i;

function hostOf(base: string): string {
  try {
    return new URL(base).hostname;
  } catch {
    return base;
  }
}

/** 挑战/封锁判定:状态码 307/513(DiamWall 握手)+ 正文特征(仅取前 4KB,覆盖 follow 后的验证页) */
function isChallengeResponse(status: number | null | undefined, text: string): boolean {
  return status === 307 || status === 513 || CHALLENGE_RE.test(text.slice(0, 4096));
}

/** 全文解码(搜索 JSON 常超 4KB,不可截断;特征检测由 isChallengeResponse 内部取头) */
function responseText(resp: { arrayBuffer: () => Promise<ArrayBuffer | Uint8Array> }): Promise<string> {
  return resp.arrayBuffer().then((buf) =>
    new TextDecoder("utf-8").decode(buf instanceof Uint8Array ? buf : new Uint8Array(buf)),
  );
}

export interface ZlibDriverOptions {
  /** 个人/官方域名(可选:留空 → 自动发现可用镜像) */
  domain?: string;
  username: string;
  password: string;
  /** remix 认证快路径(专属链接 ?remix_userid=/remix_userkey=):提供后跳过邮箱登录 */
  auth?: { id: string; key: string };
  id?: string;
  name?: string;
}

/** 详情补全字段(koplugin _transformApiBookData 的详情子集) */
export interface ZlibBookDetail {
  extension?: string;
  hash?: string;
  description?: string;
  publisher?: string;
  pages?: number | string;
  filesize?: number;
  language?: string;
  year?: string | number;
}

/** 书评条目(koplugin _renderComments 同源字段) */
export interface ZlibComment {
  id?: number | string;
  user: string;
  premium?: boolean;
  date?: string;
  text: string;
}

interface ZlibBook {
  id: number | string;
  hash: string;
  name?: string;
  title?: string;
  author?: { name?: string } | string | null;
  extension?: string;
  year?: string | number;
  language?: string;
  filesize?: number;
  href?: string;
  /** 封面图绝对 URL(搜索响应自带;koplugin 同源) */
  cover?: string;
  /** 详情字段(koplugin _transformApiBookData 同源;搜索响应自带,详情页直接展示) */
  description?: string;
  publisher?: string;
  pages?: number | string;
}

function parseZlibBooks(data: unknown): ZlibBook[] {
  const root = data as { books?: ZlibBook[]; exactMatch?: { books?: ZlibBook[] } } | null;
  // 与 koplugin 一致:普通列表在 data.books,标题精确命中时服务端用 data.exactMatch.books
  if (Array.isArray(root?.books)) return root.books;
  return Array.isArray(root?.exactMatch?.books) ? root.exactMatch.books : [];
}

function authorName(author: ZlibBook["author"]): string {
  if (!author) return "";
  return typeof author === "string" ? author : (author.name ?? "");
}

export class ZlibDriver implements BookSourceDriver {
  readonly id: string;
  readonly name: string;

  private readonly configuredDomain: string | null;
  private readonly username: string;
  private readonly password: string;
  private readonly authOverride: { id: string; key: string } | null;
  private auth: { id: string; key: string } | null = null;
  /** 实例级选定的 base(健康检查通过后缓存;换域时失效重找) */
  private baseUrl: string | null = null;
  /** 会话级封锁域(挑战页命中;只换家不绕过) */
  private readonly blockedMirrors = new Set<string>();
  /** 官方域清单缓存(命中健康域后异步刷新,并入后续探测候选;2026-09-11) */
  private dynamicDomains: string[] = [];
  private lastDomainsFetch = 0;
  /** 最热列表短缓存(60s):入口筛选连点只重排、不重复发上游请求(2026-09-11) */
  private popularCache: { base: string; books: ZlibBook[]; ts: number } | null = null;
  /** 上次成功镜像(持久化 k/v):冷启动直接复用,免掉多域探测的十几秒(首击超时根因修复) */
  private static readonly LAST_MIRROR_KEY = "localopds_driver_zlib_lastmirror";

  private async getLastMirror(): Promise<string | null> {
    try {
      const value = await getPlatformService().kvGetItem(ZlibDriver.LAST_MIRROR_KEY);
      return value || null;
    } catch {
      return null; // 平台服务未注册(测试环境)等:忽略
    }
  }

  private async saveLastMirror(host: string): Promise<void> {
    try {
      await getPlatformService().kvSetItem(ZlibDriver.LAST_MIRROR_KEY, host);
    } catch {
      // 持久化失败不影响主流程
    }
  }

  /** 当前 base 是否来自"持久化镜像直达"(未做健康检查) */
  private directBaseUsed = false;

  /** 冷启动快路径:持久化镜像直达(免健康检查,省 ~1s);无缓存则完整探测 */
  private async resolveBaseFast(fetchImpl: Fetcher): Promise<string> {
    if (this.baseUrl) return this.baseUrl;
    const last = await this.getLastMirror();
    if (last && !this.blockedMirrors.has(last)) {
      this.baseUrl = `https://${last}`;
      this.directBaseUsed = true;
      console.log(`[Zlib] using cached mirror directly: ${last}`);
      return this.baseUrl;
    }
    return this.resolveBaseUrl(fetchImpl); // 内含 directBaseUsed = false
  }

  /** 「解析 base + 发一次请求」的组合(URL/请求体可依赖 base,如 rpc.php 的 Origin/redirectUrl)。
   *  直达镜像网络层失败(域不可达)时:作废缓存 → 完整探测换家 → 重试一次。 */
  private async requestOnMirror(
    fetchImpl: Fetcher,
    build: (base: string) => { url: string; init?: NonNullable<Parameters<Fetcher>[1]> },
  ): Promise<{ resp: Response; base: string }> {
    const first = await this.resolveBaseFast(fetchImpl);
    try {
      const { url, init } = build(first);
      return { resp: await fetchImpl(url, init), base: first };
    } catch (err) {
      if (this.directBaseUsed && this.baseUrl === first) {
        console.log(
          `[Zlib] cached mirror ${hostOf(first)} unreachable (${err instanceof Error ? err.message : String(err)}); re-probing…`,
        );
        this.blockedMirrors.add(hostOf(first));
        this.baseUrl = null;
        this.directBaseUsed = false;
        const next = await this.resolveBaseUrl(fetchImpl);
        const { url, init } = build(next);
        return { resp: await fetchImpl(url, init), base: next };
      }
      throw err;
    }
  }

  constructor(options: ZlibDriverOptions) {
    const domain = (options.domain ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    this.id = options.id ?? "zlib";
    this.name = options.name ?? "Z-Library";
    this.configuredDomain = domain || null;
    this.username = options.username.trim();
    this.password = options.password;
    this.authOverride = options.auth?.id && options.auth.key ? options.auth : null;
  }

  /** Cookie 认证形态(官方会话对;不再是自定义 header) */
  private authHeaders(): Record<string, string> {
    return this.auth
      ? { Cookie: `remix_userid=${this.auth.id}; remix_userkey=${this.auth.key}` }
      : {};
  }

  /** 从已命中的健康域异步拉官方域清单并入缓存(失败静默;10 分钟内不重复;
   *  2026-09-11:不再用"用户配置域"去拉清单——它可能是死的,会把 15s 超时拖进搜索首响) */
  private async refreshDomains(base: string, fetchImpl: Fetcher): Promise<void> {
    if (Date.now() - this.lastDomainsFetch < 10 * 60_000) return;
    this.lastDomainsFetch = Date.now();
    try {
      const resp = await fetchImpl(`${base}/eapi/info/domains/singlelogin`, {
        headers: { "User-Agent": ZLIB_UA_CANDIDATES[0] },
        responseType: "text",
      });
      const text = await responseText(resp);
      if (!resp.ok || !text.startsWith("{")) return;
      const list =
        (JSON.parse(text) as { domains?: ({ domain?: string } | string)[] } | null)?.domains ?? [];
      const hosts = list
        .map((d) => (typeof d === "string" ? d : d?.domain))
        .filter((h): h is string => !!h)
        .slice(0, 40);
      if (hosts.length > 0) {
        this.dynamicDomains = hosts;
        console.log(`[Zlib] domains list refreshed from ${hostOf(base)}: ${hosts.length} hosts`);
      }
    } catch {
      // 清单获取失败:保持旧缓存,种子域兜底
    }
  }

  private async resolveBaseUrl(fetchImpl: Fetcher): Promise<string> {
    const probeStart = Date.now();
    this.directBaseUsed = false; // 完整探测路径:直达标记复位
    if (this.baseUrl) return this.baseUrl;
    if (this.blockedMirrors.has(this.configuredDomain ?? "")) {
      this.baseUrl = null;
    }
    const candidates: string[] = [];
    const configured = this.configuredDomain ? `https://${this.configuredDomain}` : null;
    if (configured && !this.blockedMirrors.has(this.configuredDomain ?? "")) candidates.push(configured);
    // 上次成功镜像优先(持久化 k/v):冷启动直接复用,免掉逐域探测的十几秒
    const lastMirror = await this.getLastMirror();
    if (lastMirror && !this.blockedMirrors.has(lastMirror)) {
      candidates.push(`https://${lastMirror}`);
    }
    // 动态域清单(此前从健康域拉到并缓存)
    for (const host of this.dynamicDomains) {
      if (!this.blockedMirrors.has(host)) candidates.push(`https://${host}`);
    }
    for (const host of ZL_SEED_DOMAINS) {
      if (!this.blockedMirrors.has(host)) candidates.push(`https://${host}`);
    }

    // 去重(保序)
    const seen = new Set<string>();
    const ordered = candidates.filter((c) => {
      const h = hostOf(c);
      if (seen.has(h)) return false;
      seen.add(h);
      return true;
    });

    // 单域探测(箭头函数捕获方法 this,blockedMirrors 正确落到实例)
    const firstOkFor = async (base: string): Promise<string | null> => {
      const host = hostOf(base);
      try {
        const resp = await fetchImpl(`${base}/eapi/info/ok`, {
          headers: { "User-Agent": ZLIB_UA_CANDIDATES[0] },
          responseType: "text",
          timeoutMs: 5_000, // 探测快速失败:死域不应把整轮候选拖到 15s
        });
        const text = await responseText(resp);
        if (isChallengeResponse(resp.status, text)) {
          this.blockedMirrors.add(host);
          console.log(`[Zlib] mirror probe ${host}: blocked (status ${resp.status})`);
          return null;
        }
        if (resp.ok && /"success"\s*:\s*1/.test(text)) {
          console.log(`[Zlib] mirror probe ${host}: ok`);
          return base;
        }
        console.log(`[Zlib] mirror probe ${host}: unexpected (status ${resp.status})`);
        return null;
      } catch (e) {
        console.log(`[Zlib] mirror probe ${host}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    };

    /** 同批并发探测,任一 ok 立即 resolve(其余 pending 的请求随超时自然结束,不阻塞调用方) */
    const firstOk = (bases: string[]): Promise<string | null> =>
      new Promise((resolve) => {
        let pending = bases.length;
        bases.forEach((base) => {
          void firstOkFor(base).then((r) => {
            if (r) resolve(r);
            pending -= 1;
            if (pending === 0) resolve(null);
          });
        });
      });

    // 并发批次探测(每批 4),且"任一命中立即返回"——不等待同批最慢域
    // (手机网络下多数域 XHR status 0 秒败,个别域会被吞包挂 15s 超时;等整批会让搜索前拖 30-60s)
    const BATCH = 4;
    for (let i = 0; i < ordered.length; i += BATCH) {
      const batch = ordered.slice(i, i + BATCH);
      const hit = await firstOk(batch);
      if (hit) {
        this.baseUrl = hit;
        void this.refreshDomains(hit, fetchImpl); // 异步刷新域清单,不阻塞本回合
        void this.saveLastMirror(hostOf(hit)); // 记住成功镜像:下次冷启动免探测
        return hit;
      }
    }
    console.log(
      `[Zlib] resolveBaseUrl took ${Date.now() - probeStart}ms (candidates=${ordered.length})`,
    );
    console.warn("[Zlib] all mirrors unreachable — see probe log above");
    throw new OpdsParseError(
      "没有可用的 Z-Library 镜像(已探测多个域名均被拦截或不可达),请稍后重试或手动指定域名",
    );
  }

  /** 登录(缓存会话对;邮箱+密码齐全时始终走 rpc.php 在线登录) */
  private async ensureAuth(fetchImpl: Fetcher = defaultFetcher): Promise<void> {
    if (this.auth?.id && this.auth.key) return;
    // 账号+密码齐全 → 在线登录优先:专属链接(可能已过期)只在无完整账号时作快路径。
    // 搜索免登录所以旧链接也能"搜得动",下载撞 400 Please login 的坑即源于此。
    if (this.username && this.password) {
      await this.rpcLogin(fetchImpl);
      return;
    }
    if (this.authOverride) {
      this.auth = this.authOverride;
      return;
    }
    await this.rpcLogin(fetchImpl);
  }

  /** rpc.php 登录;成功后设置会话对 */
  private async rpcLogin(fetchImpl: Fetcher): Promise<void> {
    const { resp, base } = await this.requestOnMirror(fetchImpl, (loginBase) => ({
      url: `${loginBase}/rpc.php`,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          Origin: loginBase,
          Referer: `${loginBase}/`,
          "User-Agent": ZLIB_UA_CANDIDATES[0],
        },
        body: new URLSearchParams({
          isModal: "true",
          email: this.username,
          password: this.password,
          site_mode: "books",
          action: "login",
          gg_json_mode: "1",
          redirectUrl: `${loginBase}/`,
        }).toString(),
        responseType: "text",
      },
    }));
    const raw = await responseText(resp);
    if (isChallengeResponse(resp.status, raw)) {
      // 登录所在镜像被拦截:标注黑名单、失效缓存,调用方换域重试(只换家不绕过)
      this.blockedMirrors.add(hostOf(base));
      this.baseUrl = null;
      throw new OpdsParseError("该 Z-Library 镜像正在拦截自动化访问,已换用其它镜像重试或稍后再试");
    }
    if (!resp.ok) throw new OpdsParseError(`ZL 登录 HTTP ${resp.status}`);
    console.log(`[Zlib] rpc.login ${hostOf(base)} -> ${resp.status}`);
    let data: {
      response?: {
        user_id?: number | string;
        user_key?: string;
        remix_userkey?: string;
        validationError?: boolean;
        message?: string;
      };
    } | null = null;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new OpdsParseError("ZL 登录返回非 JSON(可能被拦截,请换镜像或稍后再试)");
    }
    const response = data?.response;
    if (response?.validationError) {
      throw new OpdsParseError(
        response.message
          ? `Z-Library 账号或密码错误(${response.message})`
          : "Z-Library 账号或密码错误",
      );
    }
    const id = response?.user_id != null ? String(response.user_id) : "";
    const key = response?.user_key ?? response?.remix_userkey ?? "";
    if (!id || !key) throw new OpdsParseError("ZL 登录失败:响应不含凭据");
    this.auth = { id, key };
  }

  /** BookSourceDriver:搜索并产出统一 feed(UA 回退 × 镜像换家;params:order/lang/ext 筛选) */
  async search(
    query: string,
    params?: Record<string, string>,
    fetchImpl: Fetcher = defaultFetcher,
  ): Promise<OpdsFeed> {
    const searchStart = Date.now();
    // 免登录可搜(koplugin 同款):不强制登录,已有会话则自动附带 Cookie —— 省一次登录往返;
    // 登录由下载链路(download→ensureAuth)保证
    const base = await this.resolveBaseFast(fetchImpl);
    const order = params?.order || "bestmatch";
    const lang = params?.lang || "";
    const ext = params?.ext || "";
    // koplugin 同款表单字段:languages[i-1]/extensions[i-1]/order(见 api.lua search)
    const bodyParams = new URLSearchParams({ message: query, limit: "50", page: "1" });
    if (lang) bodyParams.append("languages[0]", lang);
    if (ext) bodyParams.append("extensions[0]", ext);
    bodyParams.append("order", order);
    const body = bodyParams.toString();

    let lastError: unknown = new OpdsParseError("ZL search failed");
    // 外层:镜像换家;内层:UA 回退
    for (let round = 0; round < 3; round++) {
      let current = base;
      if (round > 0) {
        this.baseUrl = null; // 强制重新发现(可能选中下一可用域)
        current = await this.resolveBaseUrl(fetchImpl);
      }
      for (const ua of ZLIB_UA_CANDIDATES) {
        try {
          const resp = await fetchImpl(`${current}/eapi/book/search`, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              Accept: "application/json, text/javascript, */*; q=0.01",
              "User-Agent": ua,
              ...this.authHeaders(),
            },
            body,
            responseType: "text",
          });
          const text = await responseText(resp);
          if (isChallengeResponse(resp.status, text)) {
            this.blockedMirrors.add(hostOf(current));
            this.baseUrl = null;
            break; // 换家重试(外层 round 循环)
          }
          if (!resp.ok || !text.startsWith("{")) {
            lastError = new OpdsParseError(`ZL search HTTP ${resp.status}`);
            continue; // 换 UA 候选
          }
          const data = JSON.parse(text) as {
            success?: boolean;
            error?: string | { message?: string } | null;
          };
          if (data.error) {
            const msg =
              typeof data.error === "string" ? data.error : (data.error?.message ?? "");
            throw new OpdsParseError(`ZL search 接口错误:${msg}`);
          }
          if (data.success === false) throw new OpdsParseError("ZL search failed");
          const books = parseZlibBooks(data);
          console.log(
            `[Zlib] search "${query}" on ${hostOf(current)} ok: ${books.length} books (order=${order}${lang ? ` lang=${lang}` : ""}${ext ? ` ext=${ext}` : ""}, ${Date.now() - searchStart}ms)`,
          );
          const feed = this.feedFromBooks(current, query, books);
          feed.facets = this.buildFacets(query, { order, lang, ext });
          return feed;
        } catch (err) {
          if (err instanceof OpdsParseError && err.message.includes("镜像")) throw err;
          lastError = err;
        }
      }
    }
    throw lastError;
  }

  /** BookSourceDriver.browse:打开即浏览——最热列表 + 全量筛选分面(免登录;koplugin /eapi/book/most-popular 同款)
   *  筛选参数在**搜索前**就可配置:分面 href 指回本入口(带参),选中后原样带入后续搜索 */
  async browse(params?: Record<string, string>, fetchImpl: Fetcher = defaultFetcher): Promise<OpdsFeed> {
    const order = params?.order || "popular";
    const lang = params?.lang || "";
    const ext = params?.ext || "";
    const now = Date.now();
    let books: ZlibBook[] | null = null;
    let base: string = this.baseUrl ?? "";
    if (
      base &&
      this.popularCache &&
      this.popularCache.base === base &&
      now - this.popularCache.ts < 60_000
    ) {
      books = this.popularCache.books; // 60s 内直接复用:筛选连点秒响应
      console.log(`[Zlib] browse most-popular from cache: ${books.length} books`);
    } else {
      const { resp, base: usedBase } = await this.requestOnMirror(fetchImpl, (b) => ({
        url: `${b}/eapi/book/most-popular`,
        init: {
          headers: { "User-Agent": ZLIB_UA_CANDIDATES[0], ...this.authHeaders() },
          responseType: "text",
        },
      }));
      base = usedBase;
      const text = await responseText(resp);
      if (isChallengeResponse(resp.status, text)) {
        this.blockedMirrors.add(hostOf(base));
        this.baseUrl = null;
        throw new OpdsParseError("该 Z-Library 镜像正在拦截自动化访问,请重试或换镜像");
      }
      if (!resp.ok || !text.startsWith("{")) {
        throw new OpdsParseError(`ZL 最热列表 HTTP ${resp.status}`);
      }
      const data = JSON.parse(text) as { success?: number; message?: string };
      if (data.success !== 1) {
        throw new OpdsParseError(data.message || "ZL 最热列表获取失败");
      }
      books = parseZlibBooks(data);
      this.popularCache = { base, books, ts: now };
      console.log(
        `[Zlib] browse most-popular on ${hostOf(base)}: ${books.length} books${lang ? ` (lang=${lang})` : ""}${ext ? ` (ext=${ext})` : ""}`,
      );
    }
    const feed = this.feedFromBooks(base, "热门", books);
    feed.facets = this.buildFacets(null, { order, lang, ext });
    return feed;
  }

  /** 书籍详情残条补全(koplugin fetchDetailsThenDownload 同款):
   *  最热列表等"简略条目"没有 extension/完整信息,按 id+短码取全字段后再下载 */
  async detail(bookId: string, hash: string, fetchImpl: Fetcher = defaultFetcher): Promise<ZlibBookDetail> {
    const { resp, base } = await this.requestOnMirror(fetchImpl, (b) => ({
      url: `${b}/eapi/book/${encodeURIComponent(bookId)}/${encodeURIComponent(hash)}`,
      init: {
        headers: { "User-Agent": ZLIB_UA_CANDIDATES[0], ...this.authHeaders() },
        responseType: "text",
      },
    }));
    const text = await responseText(resp);
    if (isChallengeResponse(resp.status, text)) {
      this.blockedMirrors.add(hostOf(base));
      this.baseUrl = null;
      throw new OpdsParseError("该 Z-Library 镜像正在拦截自动化访问,请重试或换镜像");
    }
    if (!resp.ok || !text.startsWith("{")) {
      throw new OpdsParseError(`ZL 详情 HTTP ${resp.status}`);
    }
    const data = JSON.parse(text) as { success?: number; message?: string; book?: ZlibBook };
    if (data.success !== 1 || !data.book) {
      throw new OpdsParseError(data.message || "ZL 详情获取失败");
    }
    const b = data.book;
    return {
      extension: b.extension ?? undefined,
      hash: b.hash ?? undefined,
      description: b.description ?? undefined,
      publisher: b.publisher ?? undefined,
      pages: b.pages,
      filesize: b.filesize,
      language: b.language ?? undefined,
      year: b.year,
    };
  }

  /** 开发者工具:连通性 + 凭据自检(登录 → 拉最热),返回书籍数;失败抛可读错误 */
  async testConnection(fetchImpl: Fetcher = defaultFetcher): Promise<{ books: number; base: string }> {
    await this.ensureAuth(fetchImpl);
    const base = await this.resolveBaseUrl(fetchImpl);
    const feed = await this.browse({}, fetchImpl);
    return { books: feed.publications.length, base: hostOf(base) };
  }

  /** 相似书籍(koplugin searchSimilarBooks 同款;GET /eapi/book/{id}/{hash}/similar → OPDS feed) */
  async similar(bookId: string, hash: string, fetchImpl: Fetcher = defaultFetcher): Promise<OpdsFeed> {
    const { resp, base } = await this.requestOnMirror(fetchImpl, (b) => ({
      url: `${b}/eapi/book/${encodeURIComponent(bookId)}/${encodeURIComponent(hash)}/similar`,
      init: {
        headers: { "User-Agent": ZLIB_UA_CANDIDATES[0], ...this.authHeaders() },
        responseType: "text",
      },
    }));
    const text = await responseText(resp);
    if (isChallengeResponse(resp.status, text)) {
      this.blockedMirrors.add(hostOf(base));
      this.baseUrl = null;
      throw new OpdsParseError("该 Z-Library 镜像正在拦截自动化访问,请重试或换镜像");
    }
    if (!resp.ok || !text.startsWith("{")) {
      throw new OpdsParseError(`ZL 相似书籍 HTTP ${resp.status}`);
    }
    const data = JSON.parse(text) as { success?: number; books?: ZlibBook[]; message?: string };
    if (data.success !== 1) {
      throw new OpdsParseError(data.message || "ZL 相似书籍获取失败");
    }
    const books = parseZlibBooks(data);
    console.log(`[Zlib] similar of ${bookId}: ${books.length} books`);
    return this.feedFromBooks(base, "相似书籍", books);
  }

  /** 评论(koplugin getBookComments 同款;GET /papi/comments/book/{id}/0,免登录) */
  async comments(bookId: string, fetchImpl: Fetcher = defaultFetcher): Promise<ZlibComment[]> {
    const { resp } = await this.requestOnMirror(fetchImpl, (b) => ({
      url: `${b}/papi/comments/book/${encodeURIComponent(bookId)}/0`,
      init: {
        headers: { "User-Agent": ZLIB_UA_CANDIDATES[0] },
        responseType: "text",
      },
    }));
    const text = await responseText(resp);
    if (!resp.ok || !text.startsWith("{")) {
      throw new OpdsParseError(`ZL 评论 HTTP ${resp.status}`);
    }
    const data = JSON.parse(text) as {
      success?: number;
      message?: string;
      comments?: {
        id?: number | string;
        user?: { name?: string; isPremium?: boolean };
        dateRelative?: string;
        date?: string;
        text?: string;
      }[];
    };
    if (data.success !== 1) {
      throw new OpdsParseError(data.message || "ZL 评论获取失败");
    }
    return (data.comments ?? []).map((c) => ({
      id: c.id,
      user: c.user?.name || "Anonymous",
      premium: !!c.user?.isPremium,
      date: c.dateRelative || c.date || "",
      text: c.text || "",
    }));
  }

  /** 搜索筛选分面(排序/语言/格式):同组选项重算 href(保留其余参数;query=null 时指回入口页=搜索前配置) */
  private buildFacets(
    query: string | null,
    cur: { order: string; lang: string; ext: string },
  ): OpdsFacet[] {
    const hrefFor = (over: Partial<{ order: string; lang: string; ext: string }>) => {
      const vals = { ...cur, ...over };
      const p = new URLSearchParams();
      if (query !== null) p.set("q", query);
      p.set("order", vals.order);
      if (vals.lang) p.set("lang", vals.lang);
      if (vals.ext) p.set("ext", vals.ext);
      const path = query === null ? `/opds/${this.id}/` : `/opds/${this.id}/search`;
      return `${path}?${p.toString()}`;
    };
    const facets: OpdsFacet[] = [];
    for (const o of ZL_ORDER_OPTIONS) {
      facets.push({
        group: "order",
        title: o.label,
        href: hrefFor({ order: o.value }),
        active: o.value === cur.order,
      });
    }
    facets.push({ group: "language", title: "全部", href: hrefFor({ lang: "" }), active: !cur.lang });
    for (const l of ZL_LANGUAGE_OPTIONS) {
      facets.push({
        group: "language",
        title: l.label,
        href: hrefFor({ lang: l.value }),
        active: cur.lang === l.value,
      });
    }
    facets.push({ group: "format", title: "全部", href: hrefFor({ ext: "" }), active: !cur.ext });
    for (const e of ZL_EXTENSION_OPTIONS) {
      facets.push({
        group: "format",
        title: e.label,
        href: hrefFor({ ext: e.value }),
        active: cur.ext === e.value,
      });
    }
    return facets;
  }

  /** BookSourceDriver:两步下载链(/file 解析签名直链 → GET 直链) */
  async download(params: Record<string, string>, fetchImpl: Fetcher = defaultFetcher): Promise<Uint8Array> {
    const bookId = params.id;
    const hash = params.hash;
    if (!bookId || !hash) throw new OpdsParseError("Missing id/hash");
    await this.ensureAuth(fetchImpl);
    const base = await this.resolveBaseFast(fetchImpl);
    const referer = params.href
      ? (() => {
          try {
            return new URL(params.href, base).toString();
          } catch {
            return `${base}/`;
          }
        })()
      : `${base}/`;

    let fileResp: { ok?: boolean; downloadLink?: string; allowDownload?: boolean | null; message?: string; error?: string } | null = null;
    for (let round = 0; round < 2; round++) {
      let current = base;
      if (round > 0) {
        this.baseUrl = null;
        current = await this.resolveBaseUrl(fetchImpl);
      }
      let resp: Response;
      try {
        resp = await fetchImpl(
          `${current}/eapi/book/${encodeURIComponent(bookId)}/${encodeURIComponent(hash)}/file`,
          {
            headers: { "User-Agent": ZLIB_UA_CANDIDATES[0], ...this.authHeaders() },
            responseType: "text",
          },
        );
      } catch (err) {
        // 网络层失败(域不可达等):作废当前镜像,下一轮换家
        this.blockedMirrors.add(hostOf(current));
        this.baseUrl = null;
        console.warn(
          `[Zlib] /file unreachable on ${hostOf(current)}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const text = await responseText(resp);
      if (isChallengeResponse(resp.status, text)) {
        this.blockedMirrors.add(hostOf(current));
        this.baseUrl = null;
        continue; // 换域重试一次
      }
      // 400 + {"success":0,"error":"Please login"} = 会话无效(旧专属链接/登录过期):
      // 清会话强制重新登录,再重试一轮(搜索免登录可过,下载必须有效会话)
      if (resp.status === 400 && text.startsWith("{")) {
        const j = JSON.parse(text) as { success?: number; error?: string };
        if (j.success === 0 && j.error === "Please login") {
          console.warn("[Zlib] download session invalid (Please login), re-authenticating…");
          this.auth = null;
          await this.ensureAuth(fetchImpl);
          continue;
        }
      }
      if (!resp.ok || !text.startsWith("{")) {
        throw new OpdsParseError(`ZL 下载解析 HTTP ${resp.status}`);
      }
      const parsed = JSON.parse(text) as {
        success?: number;
        file?: { downloadLink?: string; allowDownload?: boolean | null; message?: string; error?: string };
      };
      fileResp = {
        allowDownload: parsed.file?.allowDownload ?? null,
        downloadLink: parsed.file?.downloadLink,
        message: parsed.file?.message,
        error: parsed.file?.error,
      };
      break;
    }
    if (!fileResp) throw new OpdsParseError("没有可用的 Z-Library 镜像(下载解析失败)");
    if (fileResp.allowDownload === false) {
      const detail = fileResp.message || fileResp.error || "请稍后重试或检查账号配额";
      throw new OpdsParseError(`Z-Library 下载额度已达上限:${detail}`);
    }
    const downloadLink = fileResp.downloadLink;
    if (!downloadLink) throw new OpdsParseError("ZL 下载解析失败:无下载链接");

    const fileResp2 = await fetchImpl(downloadLink, {
      headers: {
        "User-Agent": ZLIB_UA_CANDIDATES[0],
        Referer: referer,
        ...this.authHeaders(),
      },
      responseType: "arraybuffer",
      timeoutMs: ZL_DOWNLOAD_TIMEOUT_MS, // 大文件:5 分钟;默认 15s 会掐断 >10MB 的书
    });
    if (!fileResp2.ok) throw new OpdsParseError(`ZL 下载 HTTP ${fileResp2.status}`);
    const bytes = new Uint8Array(await fileResp2.arrayBuffer());
    if (!looksLikeBookFile(bytes, params.extension)) {
      throw new OpdsParseError("ZL 下载返回的文件不是有效书文件(可能被拦截或配额页)");
    }
    return bytes;
  }

  feedFromBooks(base: string, query: string, books: ZlibBook[]): OpdsFeed {
    const publications: OpdsPublication[] = books.map((book) => {
      const extension = (book.extension ?? "").toLowerCase() || undefined;
      const href = book.href
        ? (() => {
            try {
              return new URL(book.href, base).toString();
            } catch {
              return book.href;
            }
          })()
        : "";
      const cover =
        book.cover && /^https?:\/\//i.test(book.cover) ? book.cover : undefined;
      return {
        id: book.id != null ? String(book.id) : undefined,
        title: book.name ?? book.title ?? "untitled",
        authors: authorName(book.author) ? [authorName(book.author)] : [],
        summary: book.description || undefined,
        publisher: book.publisher || undefined,
        extent: book.pages != null && book.pages !== "" ? String(book.pages) : undefined,
        language: book.language || undefined,
        issued: book.year != null ? String(book.year) : undefined,
        // 封面缩略图/大图(koplugin 同款字段;须为绝对 URL 才可用)
        thumbnailUrl: cover,
        coverUrl: cover,
        // 残条(无 extension,如最热列表):给详情补全入口,客户端点开时取全字段再下载
        detailHref:
          !extension && book.id != null && book.hash
            ? `/opds/${this.id}/detail?id=${encodeURIComponent(String(book.id))}&hash=${encodeURIComponent(book.hash)}`
            : undefined,
        acquisitions: extension && book.hash
          ? [
              {
                href: `/opds/${this.id}/download?id=${encodeURIComponent(String(book.id))}&hash=${encodeURIComponent(book.hash)}&extension=${encodeURIComponent(extension)}&href=${encodeURIComponent(href)}`,
                type: "",
                extension,
                priority: (OPDS_ACQUISITION_PRIORITY as readonly string[]).indexOf(extension),
                size: typeof book.filesize === "number" ? book.filesize : undefined,
              },
            ]
          : [],
      };
    });
    return {
      title: `Z-Library · ${query}`,
      href: "",
      navigation: [],
      publications,
    };
  }
}
