import { describe, expect, it } from "vitest";

import { OpdsParseError, OPDS_ACQUISITION_PRIORITY } from "./opds";
import { parseOpds2 } from "./opds2";

/** Komga / Stump 风格 OPDS-2 catalog fixture */
const KOMGA_CATALOG_JSON = `{
  "metadata": {
    "title": "Comics",
    "subtitle": "Komga collection",
    "search": {
      "template": "https://komga.example.com/opds/v2/collections/1/search?query={searchTerms}"
    }
  },
  "links": [
    { "rel": "self", "href": "https://komga.example.com/opds/v2/collections/1" },
    { "rel": "next", "href": "https://komga.example.com/opds/v2/collections/1?page=2" }
  ],
  "navigation": [
    { "title": "Publisher A", "href": "https://komga.example.com/opds/v2/publishers/A" }
  ],
  "publications": [
    {
      "metadata": {
        "identifier": "https://komga.example.com/api/v1/books/1",
        "title": "Alice in Wonderland",
        "author": [{ "name": "Carroll, Lewis" }],
        "language": "en",
        "published": "2025-01-01",
        "description": "A girl falls down a rabbit hole."
      },
      "links": [
        { "rel": "http://opds-spec.org/acquire", "type": "application/epub+zip", "href": "https://komga.example.com/api/v1/books/1/file" },
        { "rel": "http://opds-spec.org/acquire", "type": "application/pdf", "href": "https://komga.example.com/api/v1/books/1/pdf" }
      ],
      "images": [
        { "rel": "http://opds-spec.org/image/thumbnail", "href": "https://komga.example.com/thumb/1" }
      ],
      "cover": { "href": "https://komga.example.com/cover/1" }
    },
    {
      "metadata": {
        "title": "Dune",
        "author": ["Herbert, Frank"]
      },
      "links": []
    }
  ]
}`;

describe("parseOpds2", () => {
  it("parses a Komga-style catalog into the unified feed model", () => {
    const feed = parseOpds2(KOMGA_CATALOG_JSON, "https://komga.example.com/opds/v2/collections/1");

    expect(feed.title).toBe("Comics");
    expect(feed.subtitle).toBe("Komga collection");
    expect(feed.searchTemplate).toContain("{searchTerms}");
    expect(feed.nextHref).toBe("https://komga.example.com/opds/v2/collections/1?page=2");

    expect(feed.navigation).toEqual([
      { title: "Publisher A", href: "https://komga.example.com/opds/v2/publishers/A" },
    ]);

    expect(feed.publications).toHaveLength(2);
    const alice = feed.publications[0];
    expect(alice.title).toBe("Alice in Wonderland");
    expect(alice.authors).toEqual(["Carroll, Lewis"]);
    expect(alice.language).toBe("en");
    expect(alice.issued).toBe("2025-01-01");
    expect(alice.summary).toBe("A girl falls down a rabbit hole.");
    expect(alice.thumbnailUrl).toBe("https://komga.example.com/thumb/1");
    expect(alice.coverUrl).toBe("https://komga.example.com/cover/1");

    expect(alice.acquisitions.map((a) => a.extension)).toEqual(["epub", "pdf"]);
    expect(alice.acquisitions[0].priority).toBe(OPDS_ACQUISITION_PRIORITY.indexOf("epub"));

    // 无获取链接的书目:acquisitions 为空,title 仍在
    expect(feed.publications[1].title).toBe("Dune");
    expect(feed.publications[1].authors).toEqual(["Herbert, Frank"]);
    expect(feed.publications[1].acquisitions).toHaveLength(0);
  });

  it("resolves relative acquisition hrefs against the feed URL", () => {
    const feed = parseOpds2(
      JSON.stringify({
        metadata: { title: "t" },
        publications: [
          {
            metadata: { title: "b" },
            links: [
              { rel: "http://opds-spec.org/acquire", type: "application/epub+zip", href: "books/1.epub" },
            ],
          },
        ],
      }),
      "https://server.com/opds/",
    );
    expect(feed.publications[0].acquisitions[0].href).toBe("https://server.com/opds/books/1.epub");
  });

  it("accepts relative navigation links and string authors", () => {
    const feed = parseOpds2(
      JSON.stringify({
        metadata: { title: "t" },
        navigation: [{ title: "Genres", href: "/genres" }],
        publications: [],
      }),
      "https://server.com/opds/",
    );
    expect(feed.navigation).toEqual([{ title: "Genres", href: "https://server.com/genres" }]);
  });

  it("throws OpdsParseError for invalid JSON or wrong structure", () => {
    expect(() => parseOpds2("not json at all", "https://x")).toThrow(OpdsParseError);
    expect(() => parseOpds2("{}", "https://x")).toThrow(OpdsParseError);
    expect(() => parseOpds2(JSON.stringify({ metadata: { title: "x" } }), "https://x")).toThrow(
      OpdsParseError,
    );
  });
});
