/**
 * OPDS 1.x (Atom) catalog parser — 纯逻辑,无平台依赖。
 *
 * RN 无 DOMParser,统一用 @xmldom/xmldom;解析思路参照
 * packages/foliate-js/opds.js(useNS 命名空间降级、entry 分类、OpenSearch
 * defaultMap),但只覆盖 ReadAny 需要的部分:
 *   浏览(navigation 条目)、下载(acquisition)、分页(rel=next)、搜索(OpenSearch)。
 * OPDS-2 (application/opds+json) 明确不支持 —— parseOpdsFeed 会抛 OpdsParseError。
 */

import { DOMParser } from "@xmldom/xmldom";
import { htmlToPlainText } from "./html-text";

// ---- 常量(取值自 foliate-js/opds.js)----

export const OPDS_NS_ATOM = "http://www.w3.org/2005/Atom";
export const OPDS_NS_DC = "http://purl.org/dc/elements/1.1/";
export const OPDS_NS_DCTERMS = "http://purl.org/dc/terms/";
export const OPDS_NS_OPDS = "http://opds-spec.org/2010/catalog";
export const OPDS_NS_OPENSEARCH = "http://a9.com/-/spec/opensearch/1.1/";
export const OPDS_MIME_ATOM = "application/atom+xml";
export const OPDS_MIME_OPENSEARCH = "application/opensearchdescription+xml";
export const OPDS_REL_ACQUISITION = "http://opds-spec.org/acquisition";
export const OPDS_REL_FACET = "http://opds-spec.org/facet";
export const OPDS_REL_COVER = ["http://opds-spec.org/image", "http://opds-spec.org/cover"];
export const OPDS_REL_THUMBNAIL = [
  "http://opds-spec.org/image/thumbnail",
  "http://opds-spec.org/thumbnail",
];

/** 下载格式优先级(需求拍板:epub > pdf > mobi > azw3 > txt) */
export const OPDS_ACQUISITION_PRIORITY = ["epub", "pdf", "mobi", "azw3", "txt"] as const;

/** 支持入库的格式(与移动端 importBooks 的 formatMap 对齐;其他原样入库但提示) */
export const OPDS_SUPPORTED_EXTENSIONS = [
  "epub",
  "pdf",
  "mobi",
  "azw",
  "azw3",
  "cbz",
  "cbr",
  "fb2",
  "fbz",
  "txt",
  "umd",
] as const;

// ---- 持久化模型 ----

export interface OpdsSource {
  id: string; // generateId()
  name: string; // 显示名,如 "古登堡计划"
  url: string; // 根目录 feed 绝对 URL
  username: string; // "" = 匿名(OPDS Basic auth 可选)
  allowInsecure?: boolean; // http 明文服务器的移动端开关
  /** 供 UI 回显(密码本体不落 kv,走 secret key) */
  hasPassword?: boolean;
}

export const OPDS_SOURCE_LIST_KEY = "opds_sources";

export function opdsSourceSecretKey(id: string): string {
  return `opds_source_password_${id}`;
}

// ---- 目录模型 ----

export interface OpdsNavLink {
  title: string;
  href: string;
}

export interface OpdsAcquisition {
  href: string; // 已 resolve 为绝对 URL(相对链基于 feed.href)
  type: string; // 原始 MIME,如 application/epub+zip
  extension: string; // mimeToExtension 推导,如 "epub"
  priority: number; // OPDS_ACQUISITION_PRIORITY 下标;不支持格式 = -1
  size?: number; // opds:length 属性(如有)
}

export interface OpdsPublication {
  id?: string;
  title: string;
  authors: string[];
  summary?: string; // 简介(dc:summary/content)
  language?: string; // dc:language
  issued?: string; // dc:issued / dc:date
  publisher?: string; // dc:publisher
  extent?: string; // dc:extent(页数等)
  thumbnailUrl?: string;
  coverUrl?: string;
  /** 详情补全接口(rel=alternate, application/json):列表"残条"缺下载信息时按此取全字段 */
  detailHref?: string;
  acquisitions: OpdsAcquisition[];
}

export interface OpdsFeed {
  title: string;
  subtitle?: string;
  href: string; // 本次实际请求的最终 URL(相对链接 resolve 基准)
  navigation: OpdsNavLink[]; // 按文档顺序,分类/子目录
  publications: OpdsPublication[];
  nextHref?: string; // feed 级 <link rel="next">
  searchHref?: string; // feed 级 <link rel="search">(OpenSearch Description 地址)
  /** OPDS-2:搜索模板直接内联在 catalog 元数据里,无需外取 OpenSearch 文档 */
  searchTemplate?: string;
  /** OPDS-1 分面(rel=.../facet):服务端生成的筛选/排序链接(如 ZL 的最热排序/语言/格式) */
  facets?: OpdsFacet[];
}

/** OPDS 1.x facet link(同一 facetGroup 为一组选项;active=true 为当前选中项) */
export interface OpdsFacet {
  group: string;
  title: string;
  href: string;
  active?: boolean;
}

export interface OpdsOpenSearch {
  title?: string;
  template: string;
}

// ---- 错误 ----

export class OpdsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpdsParseError";
  }
}

// ---- 工具 ----

function stripControlChars(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return (code >= 0x20 && code !== 0x7f) || code > 0x7f;
    })
    .join("");
}

/**
 * 规范化书源 URL:去控制字符/空白;无 scheme 时补 https://。
 * 注意:不做去尾斜杠 —— OPDS 目录 URL 常以 "/" 结尾并以此路由。
 */
export function sanitizeOpdsUrl(url: string): string {
  const cleaned = stripControlChars(url).trim();
  if (cleaned === "") return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
}

// https://www.rfc-editor.org/rfc/rfc7231#section-3.1.1
function parseMediaType(str: string): { mediaType: string; parameters: Record<string, string> } | null {
  if (!str) return null;
  const [mediaType, ...ps] = str.split(/ *; */);
  return {
    mediaType: mediaType.toLowerCase(),
    parameters: Object.fromEntries(
      ps.map((p) => {
        const [name, val] = p.split("=");
        return [name.toLowerCase(), val?.replace(/(^"|"$)/g, "") ?? ""];
      }),
    ),
  };
}

/** 移植 foliate isOPDSCatalog:atom+xml 且 profile=opds-catalog;OPDS-2 也识别(便于报错) */
export function isOpdsCatalogType(type: string | null | undefined): boolean {
  const parsed = parseMediaType(type ?? "");
  if (!parsed) return false;
  const { mediaType, parameters } = parsed;
  if (mediaType === "application/opds+json") return true;
  return mediaType === OPDS_MIME_ATOM && parameters.profile?.toLowerCase() === "opds-catalog";
}

const MIME_TO_EXTENSION: Record<string, string> = {
  "application/epub+zip": "epub",
  "application/pdf": "pdf",
  "application/x-mobipocket-ebook": "mobi",
  "application/vnd.amazon.ebook": "azw",
  "application/vnd.amazon.ebook.azw3": "azw3",
  "text/plain": "txt",
  "application/vnd.comicbook+zip": "cbz",
  "application/vnd.comic-book+zip": "cbz",
  "application/x-cbr": "cbr",
  "application/fb2+xml": "fb2",
  "application/x-fb2": "fb2",
  "application/vnd.umd": "umd",
};

/** MIME→扩展名;无法判定时回退取 URL pathname 扩展名;都不行返回 undefined */
export function mimeToExtension(type: string, href: string): string | undefined {
  const parsed = parseMediaType(type);
  const fromMime = parsed ? MIME_TO_EXTENSION[parsed.mediaType] : undefined;
  if (fromMime) return fromMime;
  try {
    const pathname = new URL(href).pathname;
    const match = pathname.match(/\.([a-z0-9]+)$/i);
    const ext = match?.[1]?.toLowerCase();
    if (ext && (OPDS_SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) return ext;
  } catch {
    // 非绝对 URL 或不合法,回退 undefined
  }
  return undefined;
}

/** 相对/绝对 href 都解析成绝对 URL;空串/失败原样返回 */
export function resolveOpdsHref(href: string, baseUrl: string): string {
  if (!href) return "";
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

// ---- xmldom helpers ----

type XmlNode = {
  childNodes: { length: number; [index: number]: unknown };
  localName: string;
  namespaceURI: string | null;
  nodeType: number;
  attributes: NamedNodeMap;
  getAttribute(_name: string): string | null;
  textContent: string | null;
  nodeName: string;
  firstChild: unknown;
};

type XmlDocument = {
  documentElement: XmlNode | undefined;
  lookupNamespaceURI: ((_ns: string) => string | null) | undefined;
  lookupPrefix: ((_ns: string) => string | null) | undefined;
};

// 类型转换:xmldom 返回自己的文档对象,与 DOM lib 不完全兼容
function parseXmlDocument(xml: string): XmlDocument {
  // xmldom 对空串/非字符串报的是 "invalid doc source"(无信息量),这里先翻译
  if (typeof xml !== "string" || xml.trim() === "") {
    throw new OpdsParseError(`Empty feed body (${typeof xml}, length ${(xml ?? "").length})`);
  }
  return new DOMParser().parseFromString(xml, "application/xml") as unknown as XmlDocument;
}

function elements(node: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i] as XmlNode;
    if (child && child.nodeType === 1) out.push(child);
  }
  return out;
}

function textOf(node: XmlNode | null | undefined): string {
  return node?.textContent?.trim() ?? "";
}

/**
 * ignore the namespace if it doesn't appear in document at all(foliate useNS 移植):
 * 默认命名空间是 Atom,或文档出现了 :atom 前缀 → 按 namespace 匹配,否则降级只按 localName。
 */
function atomNs(doc: XmlDocument): string | null {
  const root = doc.documentElement;
  if (root && root.namespaceURI === OPDS_NS_ATOM) return OPDS_NS_ATOM;
  if (root && root.getAttribute("xmlns:atom") === OPDS_NS_ATOM) return OPDS_NS_ATOM;
  return null;
}

const isAtomElement = (node: XmlNode, name: string, ns: string | null): boolean =>
  node.localName === name && (ns === null || node.namespaceURI === ns || !node.namespaceURI);

/**
 * dc 字段匹配宽松:本地名为 language/issued/date/identifier 且不来自 Atom 命名空间
 * (xmlns:dc 前缀或无命名空间文档都命中)。
 */
const isDcElement = (node: XmlNode, names: string[]): boolean =>
  names.includes(node.localName) &&
  node.namespaceURI !== OPDS_NS_ATOM &&
  node.namespaceURI !== OPDS_NS_OPDS;

interface RawLink {
  rels: string[];
  href: string;
  type: string;
  title: string;
  length?: string;
  /** facet 专用属性(OPDS 1.x:opds:facetGroup / opds:activeFacet,兼容无前缀写法) */
  facetGroup?: string;
  activeFacet?: boolean;
}

function parseLinks(node: XmlNode, ns: string | null): RawLink[] {
  return elements(node)
    .filter((child) => isAtomElement(child, "link", ns))
    .map((link) => ({
      rels: (link.getAttribute("rel") ?? "").trim().split(/\s+/).filter(Boolean),
      href: link.getAttribute("href") ?? "",
      type: link.getAttribute("type") ?? "",
      title: link.getAttribute("title") ?? "",
      length: link.getAttribute("length") ?? undefined,
      facetGroup:
        link.getAttribute("opds:facetGroup") ?? link.getAttribute("facetGroup") ?? undefined,
      activeFacet:
        (link.getAttribute("opds:activeFacet") ?? link.getAttribute("activeFacet")) === "true",
    }));
}

const relIncludes = (link: RawLink, rel: string) => link.rels.includes(rel);

/** 明确非下载的 rel(自链接/封面/翻页/子目录/预览页等) */
const NON_DOWNLOAD_RELS = new Set([
  "self",
  "search",
  "image",
  "thumbnail",
  "next",
  "subsection",
  "related",
  "facet",
  "group",
  "alternate",
  "preview",
]);

/**
 * 判定"下载链接":
 * 1. rel 以 opds-spec.org/acquisition 开头(open-access 等变体)→ 是;
 * 2. 非规范书源容忍:rel 集合里没有任何明确非下载 rel、且 MIME/URL 能推导出
 *    支持格式的链接,也当下载(很多书源给 <link type="application/epub+zip"> 不带 rel)。
 */
function isDownloadLink(link: RawLink): boolean {
  if (link.rels.some((r) => r.startsWith(OPDS_REL_ACQUISITION))) return true;
  if (!link.href || !link.type) return false;
  if (link.rels.some((r) => NON_DOWNLOAD_RELS.has(r))) return false;
  return mimeToExtension(link.type, link.href) != null;
}

function parsePublication(entry: XmlNode, feedHref: string, ns: string | null): OpdsPublication {
  const children = elements(entry);
  const links = parseLinks(entry, ns);
  const titleNode = children.find((c) => {
    const local = (c.localName ?? "").toLowerCase();
    const nodeName = (c.nodeName ?? "").toLowerCase();
    return local === "title" || nodeName === "title" || nodeName.endsWith(":title");
  });
  let title = textOf(titleNode);
  if (!title) {
    const titledLink = links.find((l) => l.title && l.title.trim());
    title = titledLink?.title?.trim() ?? "";
  }

  const acquisitions: OpdsAcquisition[] = [];
  for (const link of links.filter(isDownloadLink)) {
    const extension = mimeToExtension(link.type, resolveOpdsHref(link.href, feedHref));
    if (!extension) continue;
    acquisitions.push({
      href: resolveOpdsHref(link.href, feedHref),
      type: link.type,
      extension,
      priority: (OPDS_ACQUISITION_PRIORITY as readonly string[]).indexOf(extension),
      size: link.length ? Number.parseInt(link.length, 10) : undefined,
    });
  }

  const findCover = (rels: string[]) => {
    const link = links.find((l) => l.rels.some((r) => rels.includes(r)) && l.href);
    return link ? resolveOpdsHref(link.href, feedHref) : undefined;
  };

  return {
    id: textOf(children.find((c) => isAtomElement(c, "id", ns))) || undefined,
    title,
    authors: children
      .filter((c) => isAtomElement(c, "author", ns))
      .map((author) => textOf(elements(author).find((sub) => sub.localName === "name")))
      .filter(Boolean),
    // 部分目录(含 ZL)的 summary/content 带 HTML 标签或实体,统一转纯文本再入库
    summary: htmlToPlainText(
      textOf(children.find((c) => isAtomElement(c, "summary", ns))) ||
        textOf(children.find((c) => isAtomElement(c, "content", ns))),
    ),
    language: textOf(children.find((c) => isDcElement(c, ["language"]))) || undefined,
    issued:
      textOf(children.find((c) => isDcElement(c, ["issued"]))) ||
      textOf(children.find((c) => isDcElement(c, ["date", "published"]))) ||
      undefined,
    publisher: textOf(children.find((c) => isDcElement(c, ["publisher"]))) || undefined,
    extent: textOf(children.find((c) => isDcElement(c, ["extent"]))) || undefined,
    thumbnailUrl: findCover(OPDS_REL_THUMBNAIL),
    coverUrl: findCover(OPDS_REL_COVER),
    detailHref: (() => {
      const link = links.find(
        (l) => l.rels.includes("alternate") && l.type.includes("json") && l.href,
      );
      return link ? resolveOpdsHref(link.href, feedHref) : undefined;
    })(),
    acquisitions,
  };
}

function parseNavigation(entry: XmlNode, feedHref: string, ns: string | null): OpdsNavLink | null {
  const children = elements(entry);
  const links = parseLinks(entry, ns);
  const catalogLink = links.find((l) => isOpdsCatalogType(l.type) && l.href);
  const fallbackLink = links.find((l) => l.href);
  const href = catalogLink?.href ?? fallbackLink?.href;
  if (!href) return null;

  // 标题获取策略：多级 Fallback，决不返回空字符串
  // 1. entry 内部 title 子标签（兼容 atom:title, dc:title, Title 等）
  const titleNode = children.find((c) => {
    const local = (c.localName ?? "").toLowerCase();
    const nodeName = (c.nodeName ?? "").toLowerCase();
    return local === "title" || nodeName === "title" || nodeName.endsWith(":title");
  });
  let title = textOf(titleNode);

  // 2. 匹配目录 link 或 fallback link 上的 title 属性
  if (!title) {
    title = (catalogLink?.title || fallbackLink?.title || "").trim();
  }

  // 3. 任一包含非空 title 的链接
  if (!title) {
    const titledLink = links.find((l) => l.title && l.title.trim());
    if (titledLink?.title) {
      title = titledLink.title.trim();
    }
  }

  // 4. content / summary / name / label 文本
  if (!title) {
    const textNode = children.find((c) => {
      const local = (c.localName ?? "").toLowerCase();
      const nodeName = (c.nodeName ?? "").toLowerCase();
      return ["content", "summary", "name", "label"].some(
        (t) => local === t || nodeName === t || nodeName.endsWith(`:${t}`),
      );
    });
    title = textOf(textNode);
  }

  // 5. 从 URL pathname 推断易读的叶子名称（如 /bookshelf/fiction -> fiction，decode 避免乱码）
  if (!title && href) {
    try {
      const resolved = resolveOpdsHref(href, feedHref);
      const pathname = new URL(resolved).pathname;
      const segments = pathname.split("/").filter(Boolean);
      const leaf = segments.pop();
      if (leaf) {
        title = decodeURIComponent(leaf).replace(/[-_+]/g, " ").trim();
      }
    } catch {
      // 忽略 URL 解析异常
    }
  }

  return {
    title: title || "在线目录",
    href: resolveOpdsHref(href, feedHref),
  };
}

/** 解析 OPDS 1.x(Atom)目录 feed。非 Atom feed(HTML/JSON 等)抛 OpdsParseError。 */
export function parseOpdsFeed(xml: string, baseUrl: string): OpdsFeed {
  let doc: XmlDocument;
  try {
    doc = parseXmlDocument(xml);
  } catch {
    throw new OpdsParseError("Not a valid XML document");
  }
  const root = doc.documentElement;
  if (!root || root.localName !== "feed") {
    throw new OpdsParseError("Not an OPDS catalog: root element is not a feed");
  }
  const ns = atomNs(doc);
  const children = elements(root);

  const feedLinks = parseLinks(root, ns);
  // 支持库结构:Atom 里同样用 rel 匹配,不需要 namespace 判定
  const nextLink = feedLinks.find((l) => relIncludes(l, "next"));
  const searchLink = feedLinks.find(
    (l) => relIncludes(l, "search") && l.href,
  );

  const navigation: OpdsNavLink[] = [];
  const publications: OpdsPublication[] = [];

  for (const entry of children.filter((c) => isAtomElement(c, "entry", ns))) {
    const entryLinks = parseLinks(entry, ns);
    const hasDownload = entryLinks.some(isDownloadLink);
    // 有封面但没有任何"目录型"链接的条目 = 不可下载的书目(ZL 热门列表等"残条"数据),
    // 归为出版物而非目录 —— 否则被渲染成文件夹,点开会把封面图当目录加载而失败(2026-09-11)
    const hasCatalogLink = entryLinks.some((l) => isOpdsCatalogType(l.type));
    const hasCoverArt = entryLinks.some((l) =>
      l.rels.some((r) => OPDS_REL_COVER.includes(r) || OPDS_REL_THUMBNAIL.includes(r)),
    );
    const isPub = hasDownload || (!hasCatalogLink && hasCoverArt);
    if (isPub) {
      publications.push(parsePublication(entry, baseUrl, ns));
    } else {
      const nav = parseNavigation(entry, baseUrl, ns);
      if (nav) navigation.push(nav);
    }
  }

  // 收集 feed 根节点的导航链接（许多 OPDS feed 将子分类直接定义在根 feed 的 link 中）
  for (const link of feedLinks.filter(
    (l) => relIncludes(l, "subsection") || (isOpdsCatalogType(l.type) && !relIncludes(l, "self")),
  )) {
    if (link.href && !relIncludes(link, "self") && !relIncludes(link, "next") && !relIncludes(link, "search")) {
      const resolvedHref = resolveOpdsHref(link.href, baseUrl);
      if (!navigation.some((n) => n.href === resolvedHref)) {
        navigation.push({
          title: link.title?.trim() || "在线目录",
          href: resolvedHref,
        });
      }
    }
  }

  // 分面:rel=http://opds-spec.org/facet 的 link(服务端筛选/排序入口)
  const facets: OpdsFacet[] = feedLinks
    .filter((l) => l.rels.includes(OPDS_REL_FACET) && l.href)
    .map((l) => ({
      group: l.facetGroup ?? "",
      title: l.title?.trim() || "",
      href: resolveOpdsHref(l.href, baseUrl),
      active: !!l.activeFacet,
    }))
    .filter((f) => f.title && f.href);

  return {
    title: textOf(children.find((c) => isAtomElement(c, "title", ns))),
    subtitle: textOf(children.find((c) => isAtomElement(c, "subtitle", ns))) || undefined,
    href: baseUrl,
    navigation,
    publications,
    nextHref: nextLink?.href ? resolveOpdsHref(nextLink.href, baseUrl) : undefined,
    searchHref: searchLink?.href ? resolveOpdsHref(searchLink.href, baseUrl) : undefined,
    facets: facets.length > 0 ? facets : undefined,
  };
}

/** 解析 OpenSearch Description(document root: OpenSearchDescription),取 OPDS 目录优先的 Url 模板 */
export function parseOpenSearch(xml: string): OpdsOpenSearch {
  let doc: XmlDocument;
  try {
    doc = parseXmlDocument(xml);
  } catch {
    throw new OpdsParseError("Not a valid XML document");
  }
  const root = doc.documentElement;
  if (!root || root.localName !== "OpenSearchDescription") {
    throw new OpdsParseError("Not an OpenSearch description");
  }
  const children = elements(root);
  const urls = children.filter((c) => c.localName === "Url");
  // 选择优先级:显式 opds-catalog profile > 裸 application/atom+xml
  // (Gutenberg 的 osd-books.xml 就是裸 atom+xml,而第一个 Url 是 text/html)> 其他
  const url =
    urls.find((u) => isOpdsCatalogType(u.getAttribute("type"))) ??
    urls.find((u) => parseMediaType(u.getAttribute("type") ?? "")?.mediaType === OPDS_MIME_ATOM) ??
    urls[0];
  if (!url) throw new OpdsParseError("OpenSearch description has no Url element");
  const template = url.getAttribute("template") ?? "";
  if (!template) throw new OpdsParseError("OpenSearch Url has no template");
  return {
    title:
      textOf(children.find((c) => c.localName === "LongName")) ||
      textOf(children.find((c) => c.localName === "ShortName")) ||
      undefined,
    template,
  };
}

/**
 * 按 foliate getOpenSearch 的 defaultMap 语义替换模板变量:
 * 搜索词必填 {searchTerms};其余缺省 {count}=100、{startIndex}/{startPage}=0、
 * {language}=*、{inputEncoding}/{outputEncoding}=UTF-8;未知变量替换为空。
 */
export function buildOpenSearchUrl(template: string, query: string): string {
  const defaults: Record<string, string> = {
    searchTerms: encodeURIComponent(query),
    query: encodeURIComponent(query), // OPDS-2 部分实现用 {query}
    count: "100",
    startIndex: "0",
    startPage: "0",
    language: "*",
    inputEncoding: "UTF-8",
    outputEncoding: "UTF-8",
  };
  return template.replace(/{([^}]+)}/g, (_, name: string) => defaults[name] ?? "");
}
