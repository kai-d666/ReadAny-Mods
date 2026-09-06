import { describe, expect, it, vi } from "vitest";

import { parseOpdsFeed } from "../opds";
import { LibgenDriver } from "./libgen";
import { createLocalOpdsRequestHandler, serializeOpdsFeed } from "./local-opds-server";

async function callHandler(
  handler: ReturnType<typeof createLocalOpdsRequestHandler>,
  method: string,
  path: string,
  host = "127.0.0.1:19090",
) {
  const response = await handler(method, path, { host });
  return {
    status: response.status,
    text: response.body ? new TextDecoder().decode(response.body) : "",
    headers: response.headers ?? {},
  };
}

describe("local opds request handler", () => {
  it("serves a root catalog listing enabled drivers", async () => {
    const handler = createLocalOpdsRequestHandler([new LibgenDriver()]);
    const response = await callHandler(handler, "GET", "/opds/");
    expect(response.status).toBe(200);
    expect(response.headers["Content-Type"]).toContain("application/atom+xml");

    const feed = parseOpdsFeed(response.text, "http://127.0.0.1:19090/opds/");
    expect(feed.navigation).toEqual([
      { title: "LibGen", href: "http://127.0.0.1:19090/opds/libgen/" },
    ]);
  });

  it("serves a driver entry feed pointing search at the local opensearch.xml, which exposes the template", async () => {
    const handler = createLocalOpdsRequestHandler([new LibgenDriver()]);
    const response = await callHandler(handler, "GET", "/opds/libgen/");
    const feed = parseOpdsFeed(response.text, "http://127.0.0.1:19090/opds/libgen/");
    expect(feed.title).toBe("LibGen");
    expect(feed.searchHref).toBe("http://127.0.0.1:19090/opds/libgen/opensearch.xml");

    const osResponse = await callHandler(handler, "GET", "/opds/libgen/opensearch.xml");
    expect(osResponse.status).toBe(200);
    expect(osResponse.text).toContain(
      'template="http://127.0.0.1:19090/opds/libgen/search?q={searchTerms}"',
    );
  });

  it("proxies search through the driver and returns a results feed", async () => {
    const driver = new LibgenDriver({ mirrors: ["https://mirror.example"] });
    vi.spyOn(driver, "search").mockResolvedValue([
      { md5: "b529a8968792449ca7368a284e7b0aec", title: "Alice", author: "Carroll, Lewis", extension: "epub", year: "1865" },
    ]);
    const handler = createLocalOpdsRequestHandler([driver]);
    const response = await callHandler(handler, "GET", "/opds/libgen/search?q=alice");
    expect(response.status).toBe(200);

    const feed = parseOpdsFeed(response.text, "http://127.0.0.1:19090/opds/libgen/");
    expect(feed.title).toBe("LibGen · alice");
    expect(feed.publications).toHaveLength(1);
    expect(feed.publications[0].acquisitions[0].href).toBe(
      "http://127.0.0.1:19090/opds/libgen/download?md5=b529a8968792449ca7368a284e7b0aec",
    );
  });

  it("returns 404 for unknown driver and 405 for non-GET", async () => {
    const handler = createLocalOpdsRequestHandler([new LibgenDriver()]);
    const notFound = await callHandler(handler, "GET", "/opds/unknown/");
    expect(notFound.status).toBe(404);
    const notAllowed = await callHandler(handler, "POST", "/opds/");
    expect(notAllowed.status).toBe(405);
  });

  it("serializes publications with acquisition links (round-trip through parseOpdsFeed)", () => {
    const driver = new LibgenDriver({ mirrors: ["https://mirror.example"] });
    const feed = driver.feedFromResults(
      "alice",
      [
        {
          md5: "b529a8968792449ca7368a284e7b0aec",
          title: "Alice",
          author: "Carroll, Lewis",
          extension: "epub",
          year: "1865",
        },
      ],
      "http://127.0.0.1:19090/opds/libgen/",
    );
    const parsed = parseOpdsFeed(serializeOpdsFeed(feed), feed.href);
    expect(parsed.publications).toHaveLength(1);
    expect(parsed.publications[0].acquisitions[0].extension).toBe("epub");
    expect(parsed.publications[0].acquisitions[0].href).toContain(
      "/get.php?md5=b529a8968792449ca7368a284e7b0aec",
    );
  });
});
