/**
 * 内置书源服务端(本地 OPDS 服务)路由(2026-09-06):
 * 把"上游驱动器"(LibGen/未来 zlib/AA)包装成标准 OPDS-1 目录,供本机书源 UI 消费。
 *
 * 路由(基于 IPlatformService.startLANServer 的 GET-only handler):
 *   GET /opds/                  → 根目录(navigation = 每个启用 driver 一个子目录)
 *   GET /opds/{driverId}/       → driver 入口 feed(searchTemplate 指向本机 /search)
 *   GET /opds/{driverId}/search?q= → driver 搜索结果 feed
 *
 * 下载:acquisition 直接指向上游直链(md5,无鉴权),不经服务端;
 *       上行/防盗链需求(ZL/AA)接入时再升级为下载代理。
 * 主机名:以请求 Host 头为准(客户端永远打 127.0.0.1)。
 */

import { OpdsParseError, type OpdsFeed } from "../opds";

/**
 * 内置书源服务端的驱动抽象(2026-09-06):
 * 一个上游一套实现(LibGen/ZL…),产出统一 OpdsFeed;
 * acquisitions 的 href 用**根相对路径**(`/opds/{id}/download?...`),
 * 客户端 parseOpdsFeed 按请求 URL resolve —— 服务端无需关心外部主机名。
 */
export interface BookSourceDriver {
  readonly id: string;
  readonly name: string;
  /** 目录检索;params = 附加筛选/排序参数(order/lang/ext 等,各驱动按需解释,忽略未知键) */
  search(query: string, params?: Record<string, string>): Promise<OpdsFeed>;
  /** 打开即浏览(可选):入口 feed(无 query)优先用它(如 ZL 的"最热");params 为筛选参数 */
  browse?(params?: Record<string, string>): Promise<OpdsFeed>;
  /** 相似书籍(可选;koplugin 同款入口):返回 OPDS feed,客户端列表可直接点开 */
  similar?(bookId: string, hash: string): Promise<OpdsFeed>;
  /** 评论(可选):返回结构化条目数组(JSON) */
  comments?(bookId: string): Promise<unknown[]>;
  /** 详情补全(可选):列表残条取全字段(extension/description 等;JSON) */
  detail?(bookId: string, hash: string): Promise<object>;
  download(params: Record<string, string>): Promise<Uint8Array>;
}

export type LocalOpdsDriver = BookSourceDriver;

export type LocalOpdsHandler = (
  method: string,
  path: string,
  headers: Record<string, string>,
) => Promise<{ status: number; body?: Uint8Array; headers?: Record<string, string> }>;

const EXT_TO_MIME: Record<string, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  mobi: "application/x-mobipocket-ebook",
  azw: "application/vnd.amazon.ebook",
  azw3: "application/vnd.amazon.ebook.azw3",
  txt: "text/plain",
  cbz: "application/vnd.comicbook+zip",
  cbr: "application/x-cbr",
  fb2: "application/fb2+xml",
  fbz: "application/x-zip-compressed-fb2",
};

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extToMime(extension: string): string {
  return EXT_TO_MIME[extension] ?? "application/octet-stream";
}

/** OpdsFeed → OPDS-1 (Atom) XML(服务端向外输出的最小实现;不需要 search link —— 客户端走 searchTemplate) */
export function serializeOpdsFeed(feed: OpdsFeed): string {
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="utf-8"?>');
  parts.push(
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opds="http://opds-spec.org/2010/catalog">',
  );
  parts.push(`<title>${xmlEscape(feed.title)}</title>`);
  parts.push(`<link rel="self" href="${xmlEscape(feed.href)}"/>`);
  if (feed.searchHref) {
    parts.push(
      `<link rel="search" type="application/opensearchdescription+xml" href="${xmlEscape(feed.searchHref)}"/>`,
    );
  }
  if (feed.subtitle) parts.push(`<subtitle>${xmlEscape(feed.subtitle)}</subtitle>`);
  if (feed.nextHref) {
    parts.push(
      `<link rel="next" type="application/atom+xml;type=feed;profile=opds-catalog" href="${xmlEscape(feed.nextHref)}"/>`,
    );
  }
  // 分面(ZL 排序/语言/格式等筛选入口;OPDS 1.x facet 规范属性)
  for (const facet of feed.facets ?? []) {
    parts.push(
      `<link rel="http://opds-spec.org/facet" href="${xmlEscape(facet.href)}" title="${xmlEscape(facet.title)}" opds:facetGroup="${xmlEscape(facet.group)}"${facet.active ? ' opds:activeFacet="true"' : ""}/>`,
    );
  }

  for (const nav of feed.navigation) {
    parts.push("<entry>");
    parts.push(`<title>${xmlEscape(nav.title)}</title>`);
    parts.push(
      `<link type="application/atom+xml;type=entry;profile=opds-catalog" href="${xmlEscape(nav.href)}"/>`,
    );
    parts.push("</entry>");
  }

  for (const pub of feed.publications) {
    parts.push("<entry>");
    parts.push(`<title>${xmlEscape(pub.title)}</title>`);
    parts.push(`<id>${xmlEscape(pub.id ?? `urn:readany:${encodeURIComponent(pub.title)}`)}</id>`);
    for (const author of pub.authors) {
      parts.push(`<author><name>${xmlEscape(author)}</name></author>`);
    }
    if (pub.language) parts.push(`<dc:language>${xmlEscape(pub.language)}</dc:language>`);
    if (pub.issued) parts.push(`<dc:issued>${xmlEscape(pub.issued)}</dc:issued>`);
    if (pub.publisher) parts.push(`<dc:publisher>${xmlEscape(pub.publisher)}</dc:publisher>`);
    if (pub.extent) parts.push(`<dc:extent>${xmlEscape(pub.extent)}</dc:extent>`);
    if (pub.summary) parts.push(`<summary>${xmlEscape(pub.summary)}</summary>`);
    if (pub.thumbnailUrl) {
      parts.push(
        `<link rel="http://opds-spec.org/image/thumbnail" type="image/jpeg" href="${xmlEscape(pub.thumbnailUrl)}"/>`,
      );
    }
    if (pub.detailHref) {
      parts.push(
        `<link rel="alternate" type="application/json" href="${xmlEscape(pub.detailHref)}"/>`,
      );
    }
    for (const acq of pub.acquisitions) {
      const lengthAttr = acq.size && acq.size > 0 ? ` length="${acq.size}"` : "";
      parts.push(
        `<link rel="http://opds-spec.org/acquisition" type="${xmlEscape(extToMime(acq.extension))}" href="${xmlEscape(acq.href)}"${lengthAttr}/>`,
      );
    }
    parts.push("</entry>");
  }

  parts.push("</feed>");
  return parts.join("\n");
}

function textResponse(
  status: number,
  message: string,
): { status: number; body: Uint8Array; headers: Record<string, string> } {
  return {
    status,
    body: new TextEncoder().encode(message),
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  };
}

function openSearchResponse(
  name: string,
  template: string,
): { status: number; body: Uint8Array; headers: Record<string, string> } {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>${xmlEscape(name)}</ShortName>
  <Url type="application/atom+xml;type=entry;profile=opds-catalog" template="${xmlEscape(template)}"/>
</OpenSearchDescription>`;
  return {
    status: 200,
    body: new TextEncoder().encode(xml),
    headers: { "Content-Type": "application/opensearchdescription+xml; charset=utf-8" },
  };
}

function opdsResponse(feed: OpdsFeed): { status: number; body: Uint8Array; headers: Record<string, string> } {
  return {
    status: 200,
    body: new TextEncoder().encode(serializeOpdsFeed(feed)),
    headers: { "Content-Type": "application/atom+xml;type=feed;profile=opds-catalog; charset=utf-8" },
  };
}

/** 构建本机书源服务端的请求处理器(喂给 platform.startLANServer) */
export function createLocalOpdsRequestHandler(
  drivers: LocalOpdsDriver[],
): LocalOpdsHandler {
  return async (method, path, headers) => {
    if (method !== "GET") return textResponse(405, "Method Not Allowed");
    try {
      const host = headers.host ?? "127.0.0.1";
      const base = `http://${host}`;
      const url = new URL(path, base);
      const segments = url.pathname.split("/").filter(Boolean);

      if (segments[0] !== "opds") return textResponse(404, "Not Found");

      // 根目录:列出全部启用的上游
      if (segments.length <= 1) {
        return opdsResponse({
          title: "ReadAny 本机书源服务",
          href: `${base}/opds/`,
          navigation: drivers.map((driver) => ({
            title: driver.name,
            href: `${base}/opds/${driver.id}/`,
          })),
          publications: [],
        });
      }

      const driver = drivers.find((item) => item.id === segments[1]);
      if (!driver) return textResponse(404, `Unknown driver: ${segments[1]}`);

      const sub = segments[2];
      const query = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";

      // OpenSearch 描述(标准路径,客户端经 feed.searchHref 取搜索模板)
      if (sub === "opensearch.xml") {
        return openSearchResponse(driver.name, `${base}/opds/${driver.id}/search?q={searchTerms}`);
      }

      // 相似书籍(koplugin "More Similar Books" 同款):返回 OPDS feed
      if (sub === "similar") {
        if (!driver.similar) return textResponse(404, "Not Found");
        const id = url.searchParams.get("id") ?? "";
        const hash = url.searchParams.get("hash") ?? "";
        if (!id || !hash) return textResponse(400, "Missing id/hash");
        return opdsResponse(await driver.similar(id, hash));
      }

      // 详情补全(koplugin fetchDetailsThenDownload 同款):列表残条取全字段
      if (sub === "detail") {
        if (!driver.detail) return textResponse(404, "Not Found");
        const id = url.searchParams.get("id") ?? "";
        const hash = url.searchParams.get("hash") ?? "";
        if (!id || !hash) return textResponse(400, "Missing id/hash");
        const book = await driver.detail(id, hash);
        return {
          status: 200,
          body: new TextEncoder().encode(JSON.stringify({ book })),
          headers: { "Content-Type": "application/json; charset=utf-8" },
        };
      }

      // 评论(koplugin "Comments" 同款):返回 JSON 条目数组
      if (sub === "comments") {
        if (!driver.comments) return textResponse(404, "Not Found");
        const id = url.searchParams.get("id") ?? "";
        if (!id) return textResponse(400, "Missing id");
        const items = await driver.comments(id);
        return {
          status: 200,
          body: new TextEncoder().encode(JSON.stringify({ comments: items })),
          headers: { "Content-Type": "application/json; charset=utf-8" },
        };
      }

      // 下载代理:驱动按参数(如 md5/id+hash)抓取,魔数校验在驱动内,客户端无感
      if (sub === "download") {
        const params: Record<string, string> = {};
        url.searchParams.forEach((value, key) => {
          params[key] = value;
        });
        const bytes = await driver.download(params);
        return {
          status: 200,
          body: bytes,
          headers: { "Content-Type": "application/octet-stream" },
        };
      }

      if (!sub || sub === "search") {
        // 附加筛选参数(order/lang/ext…)透传给驱动解释(browse 与 search 均可用)
        const extra: Record<string, string> = {};
        url.searchParams.forEach((value, key) => {
          if (key !== "q" && key !== "query") extra[key] = value;
        });
        const searchHref = `${base}/opds/${driver.id}/opensearch.xml`;
        if (!query) {
          // driver 入口:优先 browse(如 ZL 打开即出"最热"且可预配筛选);否则空目录 + 搜索框
          if (driver.browse) {
            const feed = await driver.browse(extra);
            return opdsResponse({ ...feed, searchHref: feed.searchHref ?? searchHref });
          }
          return opdsResponse({
            title: driver.name,
            href: `${base}/opds/${driver.id}/`,
            navigation: [],
            publications: [],
            searchHref,
          });
        }
        // 搜索结果同样带 searchHref:客户端据此保留搜索栏(否则搜完搜索栏消失,无法原地再搜)
        const feed = await driver.search(query, extra);
        return opdsResponse({ ...feed, searchHref: feed.searchHref ?? searchHref });
      }

      return textResponse(404, "Not Found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[LocalOpds] driver error for ${path}: ${message}`);
      if (error instanceof OpdsParseError) return textResponse(502, message);
      return textResponse(502, message);
    }
  };
}
