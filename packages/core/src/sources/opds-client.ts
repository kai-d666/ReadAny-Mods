/**
 * OPDS 客户端网络层(纯 core,走 platform.fetch,两端通用)。
 * 认证/错误规范化/重试策略参照 sync/webdav-client.ts:
 *   - Basic auth:Buffer.from(...).toString("base64")(RN 无可靠 btoa)
 *   - HTTP 错误:401→auth / 403→forbidden / 404→not-found / 5xx→server / 其他→http
 *   - 请求异常:按关键词归一 timeout / tls / network
 *   - 重试:仅 429/5xx(真正的临时故障),指数退避 500ms→1s→2s;
 *     网络/超时错误不重试 —— 它们可能已消耗完整超时,重试只会放大延迟
 * 摘要:与 webdav-client 同款策略,已由 JD 系云盘生产环境验证。
 */

// React Native/Metro cannot resolve the Node `node:buffer` protocol import.
// biome-ignore lint/style/useNodejsImportProtocol: Expo needs the buffer polyfill package name.
import { Buffer } from "buffer";
import i18n from "../i18n";
import { getPlatformService } from "../services/platform";
import {
  OPDS_MIME_ATOM,
  parseOpdsFeed,
  parseOpenSearch,
  sanitizeOpdsUrl,
  type OpdsFeed,
  type OpdsOpenSearch,
  type OpdsSource,
} from "./opds";
import { parseOpds2 } from "./opds2";

const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

export type OpdsErrorKind =
  | "auth"
  | "forbidden"
  | "not-found"
  | "timeout"
  | "network"
  | "tls"
  | "server"
  | "http"
  | "not-opds";

export class OpdsError extends Error {
  readonly kind: OpdsErrorKind;
  readonly status?: number;
  readonly url?: string;
  readonly cause?: unknown;

  constructor(
    kind: OpdsErrorKind,
    message: string,
    details: { status?: number; url?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "OpdsError";
    this.kind = kind;
    this.status = details.status;
    this.url = details.url;
    this.cause = details.cause;
  }
}

function createOpdsHttpError(status: number, url: string): OpdsError {
  switch (status) {
    case 401:
      return new OpdsError(
        "auth",
        i18n.t("library.opdsErrorAuth", {
          defaultValue: "认证失败,请检查用户名和密码。",
        }),
        { status, url },
      );
    case 403:
      return new OpdsError(
        "forbidden",
        i18n.t("library.opdsErrorForbidden", {
          defaultValue: "目录访问被拒绝,请检查账号权限。",
        }),
        { status, url },
      );
    case 404:
      return new OpdsError(
        "not-found",
        i18n.t("library.opdsErrorNotFound", {
          defaultValue: "目录地址不存在,请检查 URL。",
        }),
        { status, url },
      );
    default:
      if (status >= 500) {
        return new OpdsError(
          "server",
          i18n.t("library.opdsErrorServer", {
            defaultValue: "目录服务器异常({{status}})。",
            status,
          }),
          { status, url },
        );
      }
      return new OpdsError(
        "http",
        i18n.t("library.opdsErrorHttp", {
          defaultValue: "请求失败({{status}})。",
          status,
        }),
        { status, url },
      );
  }
}

function createRequestOpdsError(error: unknown, url: string, timeoutMs: number): OpdsError {
  const err = error as { name?: string; message?: string; cause?: { code?: string } };
  const lowerMessage = err.message?.toLowerCase() ?? "";

  if (
    err.name === "AbortError" ||
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("timed out") ||
    lowerMessage.includes("aborted") ||
    err.cause?.code === "ETIMEDOUT"
  ) {
    return new OpdsError(
      "timeout",
      i18n.t("library.opdsErrorTimeout", {
        defaultValue: "连接超时({{seconds}} 秒),请检查网络。",
        seconds: Math.max(1, Math.round(timeoutMs / 1000)),
      }),
      { url, cause: error },
    );
  }

  if (
    lowerMessage.includes("certificate") ||
    lowerMessage.includes("ssl") ||
    lowerMessage.includes("tls") ||
    err.cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  ) {
    return new OpdsError(
      "tls",
      i18n.t("library.opdsErrorTls", {
        defaultValue: "TLS 证书校验失败,请检查证书或启用「允许不安全连接」。",
      }),
      { url, cause: error },
    );
  }

  return new OpdsError(
    "network",
    i18n.t("library.opdsErrorNetwork", {
      defaultValue: "无法连接服务器,请检查网络或地址。",
    }),
    { url, cause: error },
  );
}

function createNotOpdsError(url: string, cause: unknown): OpdsError {
  return new OpdsError(
    "not-opds",
    i18n.t("library.opdsErrorNotOpds", {
      defaultValue: "服务器返回的不是有效的 OPDS 目录(需要 Atom 1.0 Feed)。",
    }),
    { url, cause },
  );
}

export class OpdsClient {
  private readonly baseUrl: string;
  private readonly authHeader: string | null;
  private readonly allowInsecure: boolean;

  constructor(source: OpdsSource, password: string) {
    this.baseUrl = sanitizeOpdsUrl(source.url);
    this.allowInsecure = source.allowInsecure ?? false;
    const username = (source.username ?? "").trim();
    if (username) {
      const credentials = `${username}:${password}`;
      // UTF-8 safe base64 encoding;btoa is unreliable in React Native/Android.
      this.authHeader = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
    } else {
      this.authHeader = null;
    }
  }

  /** 书源根 URL(UI 展示/默认 feed 用) */
  get sourceUrl(): string {
    return this.baseUrl;
  }

  /** 下载/子目录请求也要带同样的认证头(服务器可能整站 Basic auth 保护) */
  getAuthHeaders(): Record<string, string> {
    return this.authHeader ? { Authorization: this.authHeader } : {};
  }

  private isTransientStatus(status: number): boolean {
    return status === 429 || (status >= 500 && status < 600);
  }

  private async requestText(href: string, timeoutMs: number): Promise<{ text: string; contentType: string }> {
    for (let attempt = 0; ; attempt++) {
      const startTime = Date.now();
      const platform = getPlatformService();
      try {
        const response = await platform.fetch(href, {
          method: "GET",
          headers: {
            Accept: `${OPDS_MIME_ATOM}, application/opds+json, application/xml;q=0.9, */*;q=0.8`,
            ...this.getAuthHeaders(),
          },
          responseType: "text",
          allowInsecure: this.allowInsecure,
          timeoutMs,
        });
        if (response.ok) {
          const text = await response.text();
          console.log(
            `[OpdsClient] GET ${href} completed in ${Date.now() - startTime}ms (status ${response.status}, bodyLen ${text.length}, ct "${response.headers?.get?.("content-type") ?? ""}") head="${text.slice(0, 80).replace(/\n/g, " ")}"`,
          );
          return {
            text,
            contentType: response.headers?.get?.("content-type") ?? "",
          };
        }
        if (attempt < RETRY_MAX_ATTEMPTS && this.isTransientStatus(response.status)) {
          const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
          console.warn(
            `[OpdsClient] GET ${href} got ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw createOpdsHttpError(response.status, href);
      } catch (error: unknown) {
        if (error instanceof OpdsError) throw error;
        throw createRequestOpdsError(error, href, timeoutMs);
      }
    }
  }

  /** 读一个目录 feed(根目录/分类子目录/搜索结果都是它);OPDS-1 (Atom) 与 OPDS-2 (JSON) 都支持 */
  async fetchFeed(href: string, options: { timeoutMs?: number } = {}): Promise<OpdsFeed> {
    const { text, contentType } = await this.requestText(href, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // XML 文档绝不可能以 "{"/"[" 开头,按 body 首字符判断 JSON 更可靠(content-type 缺失/错误的服务器常见)
    const isJsonCatalog =
      contentType.includes("opds+json") || text.trimStart().startsWith("{");
    try {
      if (isJsonCatalog) return parseOpds2(text, href);
      return parseOpdsFeed(text, href);
    } catch (error) {
      // JSON 判断失败但内容其实是 JSON(服务器没给 content-type)时再试一次
      if (!isJsonCatalog && text.trimStart().startsWith("{")) {
        try {
          return parseOpds2(text, href);
        } catch {
          // fall through to not-opds
        }
      }
      throw createNotOpdsError(href, error);
    }
  }

  /** 读 OpenSearch Description(feed 里 rel=search 指向的地址) */
  async fetchOpenSearch(href: string, options: { timeoutMs?: number } = {}): Promise<OpdsOpenSearch> {
    const { text } = await this.requestText(href, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      return parseOpenSearch(text);
    } catch (error) {
      throw createNotOpdsError(href, error);
    }
  }

  /** 测试连接:根 feed 能取回即通过(顺带校验是有效 OPDS 目录) */
  async testConnection(): Promise<OpdsFeed> {
    return this.fetchFeed(this.baseUrl);
  }
}
