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
import type { LibgenDriver } from "./libgen";

/** 未来:ZlibDriver | AnnaDriver 联合 */
export type LocalOpdsDriver = LibgenDriver;

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
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">',
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
    if (pub.summary) parts.push(`<summary>${xmlEscape(pub.summary)}</summary>`);
    if (pub.thumbnailUrl) {
      parts.push(
        `<link rel="http://opds-spec.org/image/thumbnail" type="image/jpeg" href="${xmlEscape(pub.thumbnailUrl)}"/>`,
      );
    }
    for (const acq of pub.acquisitions) {
      parts.push(
        `<link rel="http://opds-spec.org/acquisition" type="${xmlEscape(extToMime(acq.extension))}" href="${xmlEscape(acq.href)}"/>`,
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

      // 下载代理:服务端按镜像×路径探测 + 魔数校验,客户端无感
      if (sub === "download") {
        const md5 = url.searchParams.get("md5") ?? "";
        if (!md5) return textResponse(400, "Missing md5");
        const bytes = await driver.download(md5);
        return {
          status: 200,
          body: bytes,
          headers: { "Content-Type": "application/octet-stream" },
        };
      }

      if (!sub || sub === "search") {
        if (!query) {
          // driver 入口:空目录 + searchHref 指向本机 OpenSearch 描述
          return opdsResponse({
            title: driver.name,
            href: `${base}/opds/${driver.id}/`,
            navigation: [],
            publications: [],
            searchHref: `${base}/opds/${driver.id}/opensearch.xml`,
          });
        }
        const results = await driver.search(query);
        return opdsResponse(
          driver.feedFromResults(
            query,
            results,
            `${base}/opds/${driver.id}/search?q=${encodeURIComponent(query)}`,
            `${base}/opds/${driver.id}`,
          ),
        );
      }

      return textResponse(404, "Not Found");
    } catch (error) {
      if (error instanceof OpdsParseError) return textResponse(502, error.message);
      return textResponse(502, error instanceof Error ? error.message : String(error));
    }
  };
}
