import { describe, expect, it, vi } from "vitest";

import { type FetchOptions, type IPlatformService, setPlatformService } from "../services/platform";
import { OpdsClient, OpdsError } from "./opds-client";
import type { OpdsSource } from "./opds";

function createSource(overrides: Partial<OpdsSource> = {}): OpdsSource {
  return {
    id: "src-1",
    name: "Gutenberg",
    url: "https://gutenberg.org/ebooks.opds/",
    username: "",
    ...overrides,
  };
}

const FEED_XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>古登堡计划</title>
  <entry>
    <title>Alice</title>
    <link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="https://gutenberg.org/a.epub"/>
  </entry>
</feed>`;

const OPENSEARCH_XML = `<?xml version="1.0"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <Url type="application/atom+xml;type=entry;profile=opds-catalog"
       template="https://gutenberg.org/search.opds?query={searchTerms}"/>
</OpenSearchDescription>`;

/** 假平台:记录请求,按处理函数应答 */
function installPlatform(respond: (options: FetchOptions | undefined, url: string) => Response | Promise<Response>) {
  const requests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  setPlatformService({
    async fetch(url: string, options?: FetchOptions) {
      requests.push({
        method: options?.method ?? "GET",
        url,
        headers: (options?.headers as Record<string, string>) ?? {},
      });
      return await respond(options, url);
    },
  } as unknown as IPlatformService);
  return { requests };
}

describe("OpdsClient.feed fetching", () => {
  it("fetches and parses a feed with Accept header", async () => {
    const { requests } = installPlatform(async () => new Response(FEED_XML, { status: 200 }));
    const client = new OpdsClient(createSource(), "");
    const feed = await client.fetchFeed("https://gutenberg.org/ebooks.opds/");

    expect(requests[0].url).toBe("https://gutenberg.org/ebooks.opds/");
    expect(requests[0].headers.Accept).toContain("application/atom+xml");
    expect(feed.title).toBe("古登堡计划");
    expect(feed.publications).toHaveLength(1);
  });

  it("sends Basic auth header when a username is configured", async () => {
    const { requests } = installPlatform(async () => new Response(FEED_XML, { status: 200 }));
    const client = new OpdsClient(createSource({ username: "demo" }), "secret");
    await client.fetchFeed("https://gutenberg.org/ebooks.opds/");

    expect(requests[0].headers.Authorization).toBe("Basic ZGVtbzpzZWNyZXQ=");
  });

  it("omits Authorization header for anonymous sources", async () => {
    const { requests } = installPlatform(async () => new Response(FEED_XML, { status: 200 }));
    const client = new OpdsClient(createSource(), "");
    await client.fetchFeed("https://gutenberg.org/ebooks.opds/");

    expect("Authorization" in requests[0].headers).toBe(false);
  });

  it("maps 401 to auth error and does not retry", async () => {
    const spy = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    installPlatform(spy);
    const client = new OpdsClient(createSource({ username: "u" }), "bad");
    await expect(client.fetchFeed("https://gutenberg.org/ebooks.opds/")).rejects.toMatchObject({
      kind: "auth",
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx up to RETRY_MAX_ATTEMPTS then raises server error", async () => {
    const spy = vi.fn(async () => new Response("boom", { status: 503 }));
    installPlatform(spy);
    const client = new OpdsClient(createSource(), "");
    await expect(client.fetchFeed("https://gutenberg.org/ebooks.opds/")).rejects.toMatchObject({
      kind: "server",
      status: 503,
    });
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("treats a 200 HTML page as not-opds", async () => {
    installPlatform(async () => new Response("<html><body>hi</body></html>", { status: 200 }));
    const client = new OpdsClient(createSource(), "");
    await expect(client.fetchFeed("https://example.com/")).rejects.toMatchObject({
      kind: "not-opds",
    });
  });

  it("normalizes network failures with keyword matching", async () => {
    installPlatform(async () => {
      throw new Error("XHR request timeout");
    });
    const client = new OpdsClient(createSource(), "");
    await expect(client.fetchFeed("https://example.com/opds")).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("testConnection succeeds on a valid feed", async () => {
    installPlatform(async () => new Response(FEED_XML, { status: 200 }));
    const client = new OpdsClient(createSource(), "");
    await expect(client.testConnection()).resolves.toMatchObject({ title: "古登堡计划" });
  });

  it("parses OPDS-2 JSON catalogs (application/opds+json content-type)", async () => {
    const json = JSON.stringify({
      metadata: {
        title: "Komga",
        search: { template: "https://komga.example.com/search?query={query}" },
      },
      publications: [
        {
          metadata: { title: "Book" },
          links: [
            { rel: "http://opds-spec.org/acquire", type: "application/epub+zip", href: "book.epub" },
          ],
        },
      ],
    });
    installPlatform(async () => {
      const headers = new Headers();
      headers.set("content-type", "application/opds+json");
      return new Response(json, { status: 200, headers });
    });
    const client = new OpdsClient(createSource(), "");
    const feed = await client.fetchFeed("https://komga.example.com/opds/v2/");
    expect(feed.title).toBe("Komga");
    expect(feed.searchTemplate).toContain("{query}");
    expect(feed.publications[0].acquisitions[0].extension).toBe("epub");
  });

  it("parses OPDS-2 JSON even when content-type is missing (body sniffing)", async () => {
    const json = JSON.stringify({
      metadata: { title: "noContentType" },
      publications: [],
    });
    installPlatform(async () => new Response(json, { status: 200 }));
    const client = new OpdsClient(createSource(), "");
    const feed = await client.fetchFeed("https://server.example.com/catalog");
    expect(feed.title).toBe("noContentType");
    expect(feed.publications).toHaveLength(0);
  });
});

describe("OpdsClient.openSearch", () => {
  it("fetches and parses open search description", async () => {
    installPlatform(async () => new Response(OPENSEARCH_XML, { status: 200 }));
    const client = new OpdsClient(createSource(), "");
    const os = await client.fetchOpenSearch("https://gutenberg.org/opensearch.xml");
    expect(os.template).toContain("{searchTerms}");
  });

  it("rejects non-OpenSearch response as not-opds", async () => {
    installPlatform(async () => new Response("<html/>", { status: 200 }));
    const client = new OpdsClient(createSource(), "");
    await expect(client.fetchOpenSearch("https://x/opensearch.xml")).rejects.toBeInstanceOf(
      OpdsError,
    );
  });
});
