/**
 * OPDS-2 (JSON,Readium Web Publication Manifest 变体)解析器。
 * 2026-05-18 起 OPDS 2.0 成为官方最新稳定版;Komga/Stump/php-opds 等服务端已输出。
 *
 * 结构与 fold 到统一的 OpdsFeed 模型(与 OPDS-1 同一产出),客户端/UI 侧零差异。
 * 参考:https://specs.opds.io/opds-2.0.md
 *
 * 关键差异(相对 OPDS-1):
 *   - 搜索模板内联在 metadata.search.template(无需外取 OpenSearch 文档)
 *   - 获取链接 rel 常用 "http://opds-spec.org/acquire"(亦有 acquisition 变体)
 *   - 分页链接位于 catalog 顶层 links(rel=next)
 */

import {
  OPDS_ACQUISITION_PRIORITY,
  OpdsParseError,
  mimeToExtension,
  resolveOpdsHref,
  type OpdsAcquisition,
  type OpdsFeed,
  type OpdsNavLink,
  type OpdsPublication,
} from "./opds";

interface Opds2Link {
  rel?: string;
  type?: string;
  href: string;
  title?: string;
}

interface Opds2Image {
  rel?: string;
  href?: string;
}

interface Opds2Person {
  name?: string;
}

interface Opds2Publication {
  metadata?: {
    identifier?: string;
    title?: string;
    author?: (Opds2Person | string)[];
    language?: string;
    published?: string;
    description?: string;
  };
  links?: Opds2Link[];
  images?: Opds2Image[];
  cover?: { href?: string } | Opds2Image[] | null;
}

interface Opds2Catalog {
  metadata?: {
    title?: string;
    subtitle?: string;
    search?: { template?: string };
  };
  language?: string;
  links?: Opds2Link[];
  navigation?: Opds2Link[];
  publications?: Opds2Publication[];
}

const REL_ACQUIRE = "http://opds-spec.org/acquire";

const linkRelsInclude = (link: Opds2Link, ...parts: string[]): boolean =>
  (link.rel ?? "").split(/\s+/).some((rel) => parts.some((part) => rel === part || rel.startsWith(part)));

/** 判定"获取(下载)链接":OPDS-2 用 acquire,兼容 acquisition 旧前缀 */
const isAcquisitionLink = (link: Opds2Link): boolean =>
  linkRelsInclude(link, REL_ACQUIRE, "acquire") ||
  linkRelsInclude(link, "http://opds-spec.org/acquisition");

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseAuthors(author: unknown): string[] {
  if (!Array.isArray(author)) return [];
  return author
    .map((entry) => (typeof entry === "string" ? entry : textOf((entry as Opds2Person)?.name)))
    .filter(Boolean);
}

function parsePublication(
  pub: Opds2Publication,
  feedHref: string,
): OpdsPublication {
  const metadata = pub.metadata ?? {};
  const links = Array.isArray(pub.links) ? pub.links : [];

  const acquisitions: OpdsAcquisition[] = [];
  for (const link of links.filter(isAcquisitionLink)) {
    const extension = mimeToExtension(link.type ?? "", resolveOpdsHref(link.href, feedHref));
    if (!extension) continue;
    acquisitions.push({
      href: resolveOpdsHref(link.href, feedHref),
      type: link.type ?? "",
      extension,
      priority: (OPDS_ACQUISITION_PRIORITY as readonly string[]).indexOf(extension),
    });
  }

  const images = Array.isArray(pub.images) ? pub.images : [];
  // pub.cover 是独立字段(可能对象/数组/单元素),优先作为封面;images 数组按 rel 区分
  const coverDirect = Array.isArray(pub.cover)
    ? pub.cover
    : pub.cover
      ? [pub.cover as Opds2Image]
      : [];
  const imageEntries = [...coverDirect, ...images];
  const thumbnailHref = imageEntries.find(
    (img) => img.href && (img.rel ?? "").includes("thumbnail"),
  )?.href;
  const coverHref =
    coverDirect.find((img) => img.href)?.href ??
    imageEntries.find((img) => img.href && (img.rel ?? "").includes("cover"))?.href ??
    imageEntries.find(
      (img) =>
        img.href &&
        (img.rel ?? "").includes("image") &&
        !(img.rel ?? "").includes("thumbnail"),
    )?.href;

  return {
    id: metadata.identifier || undefined,
    title: metadata.title ?? "",
    authors: parseAuthors(metadata.author as never),
    summary: metadata.description || undefined,
    language: metadata.language || undefined,
    issued: metadata.published || undefined,
    thumbnailUrl: thumbnailHref ? resolveOpdsHref(thumbnailHref, feedHref) : undefined,
    coverUrl: coverHref ? resolveOpdsHref(coverHref, feedHref) : undefined,
    acquisitions,
  };
}

function parseNavigation(nav: Opds2Link, feedHref: string): OpdsNavLink | null {
  if (!nav.href) return null;
  return {
    title: nav.title ?? "",
    href: resolveOpdsHref(nav.href, feedHref),
  };
}

/** 解析 OPDS-2 (JSON) catalog。非 JSON/结构不符 → OpdsParseError。 */
export function parseOpds2(json: string, baseUrl: string): OpdsFeed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new OpdsParseError("Not valid JSON");
  }
  const catalog = (parsed ?? {}) as Opds2Catalog;
  if (typeof catalog !== "object" || (!Array.isArray(catalog.publications) && !Array.isArray(catalog.navigation))) {
    throw new OpdsParseError("Not an OPDS-2 catalog");
  }

  const metadata = catalog.metadata ?? {};
  const links = Array.isArray(catalog.links) ? catalog.links : [];
  const navigation = Array.isArray(catalog.navigation) ? catalog.navigation : [];
  const publications = Array.isArray(catalog.publications) ? catalog.publications : [];

  const nextLink = links.find((link) => linkRelsInclude(link, "next"));

  return {
    title: metadata.title ?? "",
    subtitle: metadata.subtitle || undefined,
    href: baseUrl,
    navigation: [...navigation.map((nav) => parseNavigation(nav, baseUrl))].filter(
      (nav): nav is OpdsNavLink => nav !== null,
    ),
    publications: publications.map((pub) => parsePublication(pub, baseUrl)),
    nextHref: nextLink?.href ? resolveOpdsHref(nextLink.href, baseUrl) : undefined,
    searchTemplate: metadata.search?.template || undefined,
  };
}
