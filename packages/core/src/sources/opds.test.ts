import { describe, expect, it } from "vitest";

import {
  OPDS_ACQUISITION_PRIORITY,
  OpdsParseError,
  buildOpenSearchUrl,
  isOpdsCatalogType,
  mimeToExtension,
  parseOpdsFeed,
  parseOpenSearch,
  resolveOpdsHref,
  sanitizeOpdsUrl,
} from "./opds";

const GUTENBERG_FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <title>古登堡计划</title>
  <subtitle>自由电子书</subtitle>
  <link rel="search" type="application/opensearchdescription+xml" href="https://www.gutenberg.org/opensearch.xml"/>
  <link rel="next" type="application/atom+xml;type=feed;profile=opds-catalog" href="https://www.gutenberg.org/ebooks/search.opds?query=a&amp;page=2"/>
  <entry>
    <title>分类:小说</title>
    <link rel="subsection" type="application/atom+xml;type=entry;profile=opds-catalog" href="https://www.gutenberg.org/ebooks/bookshelf/1"/>
  </entry>
  <entry>
    <title>Alice's Adventures in Wonderland</title>
    <id>urn:gutenberg:11</id>
    <author><name>Carroll, Lewis</name></author>
    <updated>2024-01-01T00:00:00Z</updated>
    <summary>A girl falls down a rabbit hole.</summary>
    <dc:language>en</dc:language>
    <dc:issued>1865</dc:issued>
    <link rel="http://opds-spec.org/acquisition/open-access" type="application/epub+zip" href="https://www.gutenberg.org/ebooks/11.epub3.images"/>
    <link rel="http://opds-spec.org/acquisition" type="application/x-mobipocket-ebook" href="https://www.gutenberg.org/ebooks/11.kindle.images"/>
    <link rel="http://opds-spec.org/image/thumbnail" type="image/jpeg" href="https://www.gutenberg.org/cache/epub/11/pg11.cover.medium.jpg"/>
  </entry>
</feed>`;

describe("parseOpdsFeed", () => {
  it("parses Gutenberg-style feed: nav + publication + pagination + search", () => {
    const feed = parseOpdsFeed(
      GUTENBERG_FEED_XML,
      "https://www.gutenberg.org/ebooks.opds/",
    );

    expect(feed.title).toBe("古登堡计划");
    expect(feed.subtitle).toBe("自由电子书");

    expect(feed.navigation).toEqual([
      { title: "分类:小说", href: "https://www.gutenberg.org/ebooks/bookshelf/1" },
    ]);

    expect(feed.nextHref).toBe(
      "https://www.gutenberg.org/ebooks/search.opds?query=a&page=2",
    );
    expect(feed.searchHref).toBe("https://www.gutenberg.org/opensearch.xml");

    expect(feed.publications).toHaveLength(1);
    const pub = feed.publications[0];
    expect(pub.title).toBe("Alice's Adventures in Wonderland");
    expect(pub.id).toBe("urn:gutenberg:11");
    expect(pub.authors).toEqual(["Carroll, Lewis"]);
    expect(pub.language).toBe("en");
    expect(pub.issued).toBe("1865");
    expect(pub.summary).toBe("A girl falls down a rabbit hole.");
    expect(pub.thumbnailUrl).toBe(
      "https://www.gutenberg.org/cache/epub/11/pg11.cover.medium.jpg",
    );

    expect(pub.acquisitions).toHaveLength(2);
    const [epub, mobi] = pub.acquisitions;
    expect(epub.extension).toBe("epub");
    expect(epub.priority).toBe(OPDS_ACQUISITION_PRIORITY.indexOf("epub"));
    expect(epub.href).toBe("https://www.gutenberg.org/ebooks/11.epub3.images");
    expect(mobi.extension).toBe("mobi");
    expect(mobi.priority).toBe(OPDS_ACQUISITION_PRIORITY.indexOf("mobi"));
  });

  it("resolves relative hrefs against the feed URL", () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>base</title>
  <entry>
    <title>novel</title>
    <link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="novel.epub"/>
  </entry>
</feed>`;
    const feed = parseOpdsFeed(xml, "https://server.com/opds/catalog/");
    expect(feed.publications[0].acquisitions[0].href).toBe(
      "https://server.com/opds/catalog/novel.epub",
    );
  });

  it("tolerates non-standard sources without namespace (localName matching)", () => {
    const xml = `<?xml version="1.0"?>
<feed>
  <title>无命名空间目录</title>
  <entry>
    <title>novel</title>
    <link type="application/pdf" href="https://server.com/book.pdf"/>
  </entry>
</feed>`;
    const feed = parseOpdsFeed(xml, "https://server.com/opds");
    // 无 rel 但有可下载 MIME 的链接 → 按下载条目处理(容忍非规范书源)
    expect(feed.publications).toHaveLength(1);
    expect(feed.publications[0].acquisitions[0].extension).toBe("pdf");
    expect(feed.navigation).toHaveLength(0);
  });

  it("classifies subsection entries as navigation, skips linkless entries", () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>b</title>
  <entry>
    <title>分类</title>
    <link type="application/atom+xml;type=entry;profile=opds-catalog" href="https://server.com/sub1"/>
  </entry>
  <entry><title>无链接的条目</title></entry>
</feed>`;
    const feed = parseOpdsFeed(xml, "https://server.com/opds");
    expect(feed.navigation).toEqual([{ title: "分类", href: "https://server.com/sub1" }]);
    expect(feed.publications).toHaveLength(0);
  });

  it("treats cover-only entries (no download, no catalog link) as publications, not navigation", () => {
    // ZL 最热列表"残条"形态:只有封面、没有下载链接 —— 必须归为出版物,
    // 否则被渲染成目录项,点开把封面图当目录加载(2026-09-11 实锤 bug)
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>b</title>
  <entry>
    <title>The Odyssey</title>
    <link rel="http://opds-spec.org/image/thumbnail" type="image/jpeg" href="https://cdn.example/covers/ody.jpg"/>
    <link rel="alternate" type="application/json" href="/opds/zlib/detail?id=4774597&amp;hash=74c80f"/>
  </entry>
</feed>`;
    const feed = parseOpdsFeed(xml, "https://server.com/opds/zlib/");
    expect(feed.navigation).toHaveLength(0);
    expect(feed.publications).toHaveLength(1);
    expect(feed.publications[0].title).toBe("The Odyssey");
    expect(feed.publications[0].thumbnailUrl).toBe("https://cdn.example/covers/ody.jpg");
    expect(feed.publications[0].detailHref).toBe(
      "https://server.com/opds/zlib/detail?id=4774597&hash=74c80f",
    );
  });

  it("extracts navigation title from link title attribute when entry has no title tag", () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>urn:tag:1</id>
    <link rel="subsection" title="科幻小说" type="application/atom+xml;profile=opds-catalog" href="category/scifi"/>
  </entry>
</feed>`;
    const feed = parseOpdsFeed(xml, "https://server.com/opds/");
    expect(feed.navigation).toEqual([
      { title: "科幻小说", href: "https://server.com/opds/category/scifi" },
    ]);
  });

  it("extracts navigation title from dc:title, content/summary, and fallback URL pathname", () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <entry>
    <dc:title>历史地理</dc:title>
    <link rel="subsection" href="/categories/history"/>
  </entry>
  <entry>
    <content type="text">哲学思想</content>
    <link rel="subsection" href="/categories/philosophy"/>
  </entry>
  <entry>
    <link rel="subsection" href="/categories/popular-science"/>
  </entry>
</feed>`;
    const feed = parseOpdsFeed(xml, "https://server.com/opds/");
    expect(feed.navigation).toEqual([
      { title: "历史地理", href: "https://server.com/categories/history" },
      { title: "哲学思想", href: "https://server.com/categories/philosophy" },
      { title: "popular science", href: "https://server.com/categories/popular-science" },
    ]);
  });

  it("collects feed-level subsection links into navigation", () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Feed Level</title>
  <link rel="subsection" title="热门排行" href="ranking" type="application/atom+xml;profile=opds-catalog"/>
</feed>`;
    const feed = parseOpdsFeed(xml, "https://server.com/opds/");
    expect(feed.navigation).toEqual([
      { title: "热门排行", href: "https://server.com/opds/ranking" },
    ]);
  });

  it("throws OpdsParseError for JSON / HTML / non-feed roots", () => {
    expect(() => parseOpdsFeed('{"metadata":{"title":"x"}}', "https://server.com")).toThrow(
      OpdsParseError,
    );
    expect(() =>
      parseOpdsFeed("<!DOCTYPE html><html><body>Not a feed</body></html>", "https://server.com"),
    ).toThrow(OpdsParseError);
    expect(() =>
      parseOpdsFeed("<rss><channel><title>rss</title></channel></rss>", "https://server.com"),
    ).toThrow(OpdsParseError);
  });

  it("ignores non-download rels (alternate/self/preview) when collecting acquisitions", () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>b</title>
  <entry>
    <title>novel</title>
    <link rel="alternate" type="text/html" href="https://server.com/page/1"/>
    <link rel="preview" type="application/epub+zip" href="https://server.com/preview.epub"/>
    <link type="application/epub+zip" href="https://server.com/download.epub"/>
  </entry>
</feed>`;
    const feed = parseOpdsFeed(xml, "https://server.com/opds");
    // alternate 与 preview 都排除,只剩无 rel 的下载链接
    expect(feed.publications).toHaveLength(1);
    expect(feed.publications[0].acquisitions.map((a) => a.href)).toEqual([
      "https://server.com/download.epub",
    ]);
  });
});

describe("parseOpenSearch + buildOpenSearchUrl", () => {
  const OPENSEARCH_XML = `<?xml version="1.0"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Gutenberg Search</ShortName>
  <Description>Search Gutenberg OPDS</Description>
  <Url type="application/atom+xml;type=entry;profile=opds-catalog"
       template="https://www.gutenberg.org/ebooks/search.opds?query={searchTerms}&amp;startIndex={startIndex}"/>
</OpenSearchDescription>`;

  it("picks the OPDS-catalog Url and builds a query URL", () => {
    const os = parseOpenSearch(OPENSEARCH_XML);
    expect(os.title).toBe("Gutenberg Search");
    expect(buildOpenSearchUrl(os.template, "D&d")).toBe(
      "https://www.gutenberg.org/ebooks/search.opds?query=D%26d&startIndex=0",
    );
  });

  it("fills defaults for count/startPage/language encodings", () => {
    const template =
      "https://x.example/?q={searchTerms}&c={count}&p={startPage}&l={language}&io={inputEncoding}&oo={outputEncoding}";
    expect(buildOpenSearchUrl(template, "dune")).toBe(
      "https://x.example/?q=dune&c=100&p=0&l=*&io=UTF-8&oo=UTF-8",
    );
  });

  it("replaces unknown variables with empty string", () => {
    const template = "https://x.example/?q={searchTerms}&z={unknownParam}";
    expect(buildOpenSearchUrl(template, "b")).toBe("https://x.example/?q=b&z=");
  });

  it("throws on non-OpenSearch documents", () => {
    expect(() => parseOpenSearch("<html><body>x</body></html>")).toThrow(OpdsParseError);
  });

  it("prefers bare application/atom+xml Url over text/html (Gutenberg osd style)", () => {
    const os = parseOpenSearch(`<?xml version="1.0"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <Url type="text/html" template="https://gutenberg.org/ebooks/search/?query={searchTerms}"/>
  <Url type="application/atom+xml" template="https://gutenberg.org/ebooks/search.opds/?query={searchTerms}"/>
</OpenSearchDescription>`);
    expect(os.template).toBe("https://gutenberg.org/ebooks/search.opds/?query={searchTerms}");
  });
});

describe("helpers", () => {
  it("sanitizeOpdsUrl adds https scheme and strips control chars", () => {
    expect(sanitizeOpdsUrl("  server.com/opds  ")).toBe("https://server.com/opds");
    expect(sanitizeOpdsUrl("http://192.168.1.5:8083/opds")).toBe(
      "http://192.168.1.5:8083/opds",
    );
    expect(sanitizeOpdsUrl("\u0000https://x.com/")).toBe("https://x.com/");
    expect(sanitizeOpdsUrl("")).toBe("");
  });

  it("mimeToExtension maps known MIME types and falls back to URL extension", () => {
    expect(mimeToExtension("application/epub+zip", "x.epub")).toBe("epub");
    expect(mimeToExtension("application/x-mobipocket-ebook", "x.mobi")).toBe("mobi");
    expect(mimeToExtension("application/vnd.amazon.ebook", "x")).toBe("azw");
    expect(mimeToExtension("application/octet-stream", "https://x.com/book.pdf")).toBe("pdf");
    expect(mimeToExtension("application/octet-stream", "https://x.com/book.xyz")).toBeUndefined();
    expect(mimeToExtension("", "https://x.com/book")).toBeUndefined();
  });

  it("isOpdsCatalogType recognizes opds catalog variants", () => {
    expect(
      isOpdsCatalogType("application/atom+xml;type=entry;profile=opds-catalog"),
    ).toBe(true);
    expect(isOpdsCatalogType("application/atom+xml;profile=opds-catalog")).toBe(true);
    expect(isOpdsCatalogType("application/opds+json")).toBe(true);
    expect(isOpdsCatalogType("application/atom+xml")).toBe(false);
    expect(isOpdsCatalogType(null)).toBe(false);
  });

  it("resolveOpdsHref handles absolute/relative and keeps invalid hrefs as-is", () => {
    expect(resolveOpdsHref("/sub/catalog", "https://server.com/opds/")).toBe(
      "https://server.com/sub/catalog",
    );
    expect(resolveOpdsHref("https://other.com/x", "https://server.com/opds/")).toBe(
      "https://other.com/x",
    );
    expect(resolveOpdsHref("", "https://server.com/opds/")).toBe("");
  });
});
