/**
 * Z-Library 上游驱动器(逆向官方 App 的 eAPI,2026-09-06)。
 *
 * 契约(依据 baroxyton/zlibrary-eapi-documentation,官方 App 同款接口):
 *   登录  POST {domain}/eapi/user/login    body: email, password (form)
 *         → user_profile.{id, remix_userkey}(认证头 remix-userid/remix-userkey)
 *   搜索  POST {domain}/eapi/book/search   body: message, limit, page
 *         → { success, books: [{ id, hash, name, author…, extension, year, language }] }
 *   下载  GET  {domain}/eapi/book/{id}/{hash}(需 remix 头,且 domain 必须是个人域名)
 * 请求必须带 UA;响应统一 success 标志。
 *
 * 注:author 字段结构各版本不一(string 或 {name}),解析时防御;真机校验后修正。
 */
import {
  defaultFetcher,
  looksLikeBookFile,
  type Fetcher,
} from "./fetcher";
import {
  OPDS_ACQUISITION_PRIORITY,
  OpdsParseError,
  type OpdsFeed,
  type OpdsPublication,
} from "../opds";
import type { BookSourceDriver } from "./local-opds-server";

// DiamWall 放行策略未文档化:浏览器 UA(Mozilla/…)必触发挑战;
// 官方客户端生态用字面 "CLI"(Node),官方 Android App 用其 App 串 —— 多候选自动回退。
const ZLIB_UA_CANDIDATES = [
  "zlibrary-app/0.8.5 (Android 13; API 33)",
  "CLI",
  "zlibrary/1.0 (Android)",
];

export interface ZlibDriverOptions {
  /** 个人/官方域名,如 singlelogin.me(下载必需个人域名) */
  domain: string;
  username: string;
  password: string;
  /** remix 认证(专属链接 ?remix_userid=/remix_userkey=):提供后跳过 email 登录 */
  auth?: { id: string; key: string };
  id?: string;
  name?: string;
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
}

function parseZlibBooks(data: unknown): ZlibBook[] {
  const root = data as { books?: ZlibBook[] } | null;
  return Array.isArray(root?.books) ? root.books : [];
}

function authorName(author: ZlibBook["author"]): string {
  if (!author) return "";
  return typeof author === "string" ? author : (author.name ?? "");
}

export class ZlibDriver implements BookSourceDriver {
  readonly id: string;
  readonly name: string;

  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly authOverride: { id: string; key: string } | null;
  private auth: { id: string; key: string } | null = null;

  constructor(options: ZlibDriverOptions) {
    const domain = options.domain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    if (!domain) throw new OpdsParseError("ZL domain is required");
    this.id = options.id ?? "zlib";
    this.name = options.name ?? "Z-Library";
    this.baseUrl = `https://${domain}`;
    this.username = options.username.trim();
    this.password = options.password;
    this.authOverride = options.auth?.id && options.auth.key ? options.auth : null;
  }

  private authHeaders(): Record<string, string> {
    return this.auth
      ? { "remix-userid": this.auth.id, "remix-userkey": this.auth.key }
      : {};
  }

  /** 登录(缓存凭证;失败抛 OpdsParseError);有 remix 认证时直接使用 */
  private async ensureAuth(fetchImpl: Fetcher = defaultFetcher): Promise<void> {
    if (this.auth?.id && this.auth.key) return;
    if (this.authOverride) {
      this.auth = this.authOverride;
      return;
    }
    const body = new URLSearchParams({
      email: this.username,
      password: this.password,
    }).toString();
    const response = await fetchImpl(`${this.baseUrl}/eapi/user/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": ZLIB_UA_CANDIDATES[0],
      },
      body,
      responseType: "text",
    });
    if (!response.ok) throw new OpdsParseError(`ZL login HTTP ${response.status}`);
    const data = (await response.json()) as {
      success?: boolean;
      user_profile?: { id?: number | string; remix_userkey?: string };
      user?: { id?: number | string; remix_userkey?: string };
    };
    const profile = data.user_profile ?? data.user;
    const id = profile?.id != null ? String(profile.id) : "";
    const key = profile?.remix_userkey ?? "";
    if (!id || !key) throw new OpdsParseError("ZL login failed: no credentials in response");
    this.auth = { id, key };
  }

  /** BookSourceDriver:搜索并产出统一 feed */
  async search(query: string, fetchImpl: Fetcher = defaultFetcher): Promise<OpdsFeed> {
    await this.ensureAuth(fetchImpl);
    const body = new URLSearchParams({
      message: query,
      limit: "50",
      page: "1",
    }).toString();
    let lastError: unknown = new OpdsParseError("ZL search failed");
    for (const ua of ZLIB_UA_CANDIDATES) {
      const response = await fetchImpl(`${this.baseUrl}/eapi/book/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": ua,
          ...this.authHeaders(),
        },
        body,
        responseType: "text",
      });
      if (!response.ok) {
        lastError = new OpdsParseError(`ZL search HTTP ${response.status}`);
        continue; // DiamWall 挑战(307/513)等 → 换 UA 候选
      }
      const data = (await response.json()) as { success?: boolean };
      if (data.success === false) throw new OpdsParseError("ZL search failed");
      const books = parseZlibBooks(data);
      return this.feedFromBooks(query, books);
    }
    throw lastError;
  }

  /** BookSourceDriver:下载 /eapi/book/{id}/{hash}(需 remix 头) */
  async download(params: Record<string, string>, fetchImpl: Fetcher = defaultFetcher): Promise<Uint8Array> {
    const bookId = params.id;
    const hash = params.hash;
    if (!bookId || !hash) throw new OpdsParseError("Missing id/hash");
    await this.ensureAuth(fetchImpl);
    const response = await fetchImpl(
      `${this.baseUrl}/eapi/book/${encodeURIComponent(bookId)}/${encodeURIComponent(hash)}`,
      {
        headers: { "User-Agent": ZLIB_UA_CANDIDATES[0], ...this.authHeaders() },
        responseType: "arraybuffer",
      },
    );
    if (!response.ok) throw new OpdsParseError(`ZL download HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!looksLikeBookFile(bytes, params.extension)) {
      throw new OpdsParseError("ZL download returned a non-book response");
    }
    return bytes;
  }

  feedFromBooks(query: string, books: ZlibBook[]): OpdsFeed {
    const publications: OpdsPublication[] = books.map((book) => {
      const extension = (book.extension ?? "").toLowerCase() || undefined;
      return {
        id: book.id != null ? String(book.id) : undefined,
        title: book.name ?? book.title ?? "untitled",
        authors: authorName(book.author) ? [authorName(book.author)] : [],
        language: book.language || undefined,
        issued: book.year != null ? String(book.year) : undefined,
        acquisitions: extension && book.hash
          ? [
              {
                href: `/opds/${this.id}/download?id=${encodeURIComponent(String(book.id))}&hash=${encodeURIComponent(book.hash)}&extension=${encodeURIComponent(extension)}`,
                type: "",
                extension,
                priority: (OPDS_ACQUISITION_PRIORITY as readonly string[]).indexOf(extension),
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
