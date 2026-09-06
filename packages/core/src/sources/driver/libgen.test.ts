import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIBGEN_MIRRORS,
  LibgenDriver,
  parseLibgenSearchHtml,
  type Fetcher,
} from "./libgen";

/** 从 libgen.li 真实结果页(2026-09-06 实测)截取的结果行结构 */
const RESULT_ROW = `<tr>
<td><a href="/index.php?req=alice&amp;column=def" class="search_menu">Alice's adventures in wonderland</a>;Barnes &amp; Noble classics</td>
<td>(Fictitious character from Carroll) Alice</td>
<td>Barnes &amp; Noble Classics</td>
<td>2004</td>
<td>English</td>
<td>0 / (xxxiii, 286 pages) : illustrations</td>
<td>5 MB</td>
<td>epub</td>
<td><a href="/ads.php?md5=b529a8968792449ca7368a284e7b0aec">1</a> <a href="/get.php?md5=268bb8267f7276b1f30cc7b7c923506e">2</a> <a href="http://books.google.com?">3</a> <a href="https://www.youtube.com?">4</a> <a href="/get.php?md5=268bb8267f7276b1f30cc7b7c923506e" target="_blank">5</a></td>
</tr>`;

const RESULT_ROW_NO_SIZE = `<tr>
<td>Some book title</td>
<td>Some Author</td>
<td>Some Publisher</td>
<td>1999</td>
<td>English</td>
<td>desc</td>
<td></td>
<td></td>
<td><a href="/get.php?md5=abc123def4567890aabbccddeeff0011">1</a></td>
</tr>`;

describe("parseLibgenSearchHtml", () => {
  it("parses a real libgen.li result row (column order title/author/publisher/year/lang/desc/size/ext)", () => {
    const html = `<table>${RESULT_ROW}</table>`;
    const results = parseLibgenSearchHtml(html);

    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result.title).toBe("Alice's adventures in wonderland;Barnes & Noble classics");
    expect(result.author).toBe("(Fictitious character from Carroll) Alice");
    expect(result.publisher).toBe("Barnes & Noble Classics");
    expect(result.year).toBe("2004");
    expect(result.language).toBe("English");
    expect(result.size).toBe(5 * 1024 * 1024);
    expect(result.extension).toBe("epub");
    expect(result.md5).toBe("268bb8267f7276b1f30cc7b7c923506e");
  });

  it("skips control rows without md5 links", () => {
    const html = `<table>
<tr><td>Show Covers</td><td>control</td></tr>
${RESULT_ROW}
</table>`;
    const results = parseLibgenSearchHtml(html);
    expect(results).toHaveLength(1);
  });

  it("tolerates rows with missing size/extension", () => {
    const results = parseLibgenSearchHtml(`<table>${RESULT_ROW_NO_SIZE}</table>`);
    expect(results).toHaveLength(1);
    expect(results[0].size).toBeUndefined();
    expect(results[0].extension).toBeUndefined();
  });

  it("returns empty list for non-result pages", () => {
    expect(parseLibgenSearchHtml("<html><body>no results</body></html>")).toEqual([]);
  });
});

describe("LibgenDriver", () => {
  it("searches the first reachable mirror and falls back on failure", async () => {
    const driver = new LibgenDriver({ mirrors: ["https://m1", "https://m2"] });
    let callCount = 0;
    const fetchImpl = async (url: string) => {
      callCount += 1;
      if (url.startsWith("https://m1")) throw new Error("connection refused");
      return new Response(`<table>${RESULT_ROW}</table>`, { status: 200 });
    };
    const results = await driver.search("alice", fetchImpl);
    expect(callCount).toBe(2);
    expect(results).toHaveLength(1);
  });

  it("feedFromResults produces acquisition with upstream md5 download link", () => {
    const driver = new LibgenDriver({ mirrors: [...DEFAULT_LIBGEN_MIRRORS] });
    const feed = driver.feedFromResults(
      "alice",
      [
        {
          md5: "268bb8267f7276b1f30cc7b7c923506e",
          title: "Alice's adventures in wonderland",
          author: "Lewis Carroll",
          extension: "epub",
          year: "2004",
        },
      ],
      "http://127.0.0.1:19090/opds/libgen/",
    );
    expect(feed.publications[0].title).toBe("Alice's adventures in wonderland");
    expect(feed.publications[0].acquisitions).toHaveLength(1);
    expect(feed.publications[0].acquisitions[0].href).toContain("/get.php?md5=268bb8267f7276b1f30cc7b7c923506e");
    expect(feed.publications[0].acquisitions[0].priority).toBe(0); // epub 首位
  });

  it("all mirrors failing raises OpdsParseError", async () => {
    const driver = new LibgenDriver({ mirrors: ["https://m1"] });
    await expect(
      driver.search("alice", async () => {
        throw new Error("all down");
      }),
    ).rejects.toThrow(/均不可用/);
  });

  it("feedFromResults points acquisition at the local download proxy when downloadBase given", () => {
    const driver = new LibgenDriver({ mirrors: ["https://m1"] });
    const feed = driver.feedFromResults(
      "alice",
      [{ md5: "b529a8968792449ca7368a284e7b0aec", title: "A", author: "", extension: "epub" }],
      "http://127.0.0.1:19090/opds/libgen/",
      "http://127.0.0.1:19090/opds/libgen",
    );
    expect(feed.publications[0].acquisitions[0].href).toBe(
      "http://127.0.0.1:19090/opds/libgen/download?md5=b529a8968792449ca7368a284e7b0aec",
    );
  });

  it("download follows the standard two-step chain: ads page → keyed get.php link → file", async () => {
    const driver = new LibgenDriver({ mirrors: ["https://m1"] });
    const adsHtml = `<html><a href="https://m1/get.php?md5=abc123def4567890aabbccddeeff0011&amp;key=freshkey">GET</a></html>`;
    const calls: string[] = [];
    const fetchImpl: Fetcher = async (url) => {
      calls.push(url);
      if (url.includes("ads.php")) return new Response(adsHtml, { status: 200 });
      return new Response(new TextEncoder().encode("PKdummyepubbody-12345"), { status: 200 });
    };
    const bytes = await driver.download("abc123def4567890aabbccddeeff0011", fetchImpl);
    expect(calls).toEqual([
      "https://m1/ads.php?md5=abc123def4567890aabbccddeeff0011",
      "https://m1/get.php?md5=abc123def4567890aabbccddeeff0011&key=freshkey",
    ]);
    expect(new TextDecoder().decode(bytes)).toContain("dummyepubbody");
  });

  it("download refreshes the key once when the first file response is HTML (expired key)", async () => {
    const driver = new LibgenDriver({ mirrors: ["https://m1"] });
    const calls: string[] = [];
    const fetchImpl: Fetcher = async (url) => {
      calls.push(url);
      if (url.includes("ads.php")) {
        const n = calls.filter((c) => c.includes("ads.php")).length;
        return new Response(
          `<a href="https://m1/get.php?md5=abc123def4567890aabbccddeeff0011&amp;key=k${n}">GET</a>`,
          { status: 200 },
        );
      }
      const isFirst = calls.filter((c) => c.includes("get.php")).length === 1;
      return new Response(
        isFirst
          ? new TextEncoder().encode("<html>expired</html>")
          : new TextEncoder().encode("PKx-file-body-12345"),
        { status: 200 },
      );
    };
    const bytes = await driver.download("abc123def4567890aabbccddeeff0011", fetchImpl);
    expect(calls.filter((c) => c.includes("ads.php"))).toHaveLength(2);
    expect(calls.filter((c) => c.includes("get.php"))).toHaveLength(2);
    expect(bytes.byteLength).toBeGreaterThan(2);
  });

  it("download raises when every mirror fails to yield a file", async () => {
    const driver = new LibgenDriver({ mirrors: ["https://m1"] });
    await expect(
      driver.download("x", async () => new Response("<html>no link</html>", { status: 200 })),
    ).rejects.toThrow(/下载失败/);
  });
});
